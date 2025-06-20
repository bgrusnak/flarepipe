// src/client.js

const Poller = require('./poller');
const WorkerPool = require('./worker-pool');
const RouteMatcher = require('./route-matcher');
const { validateHost, validateForwardRule, validateConcurrency, validateAuthKey, validatePrefix } = require('./utils/validator');

class TunnelClient {
    /**
     * Creates a new tunnel client
     * @param {object} options - Configuration options
     */
    constructor(options = {}) {
        this.host = null;
        this.authKey = null;
        this.prefix = '';
        this.forwardRules = [];
        this.concurrency = 16;
        this.localHost = 'localhost';
        this.tunnelId = null;
        this.isRunning = false;
        this.startPromise = null; // Prevent concurrent starts

        // Components
        this.poller = null;
        this.workerPool = null;
        this.routeMatcher = null;

        // Configuration
        this.requestTimeout = options.requestTimeout || 30000; // 30 seconds
        this.maxRequestSize = options.maxRequestSize || 10 * 1024 * 1024; // 10MB
        this.streamThreshold = options.streamThreshold || 512 * 1024; // 512KB for streaming
        this.maxStreamSize = options.maxStreamSize || 100 * 1024 * 1024; // 100MB max
        this.chunkSize = options.chunkSize || 64 * 1024; // 64KB chunks
        this.streamTimeout = options.streamTimeout || 60000; // 1 minute for streams
        this.retryAttempts = options.retryAttempts || 3;
        this.retryDelay = options.retryDelay || 1000;
        this.enableCompression = options.enableCompression !== false;

        // Statistics
        this.stats = {
            requestsProcessed: 0,
            requestsSucceeded: 0,
            requestsFailed: 0,
            bytesTransferred: 0,
            streamsProcessed: 0,
            startTime: null,
            lastRequestTime: null
        };
    }

    /**
     * Configures the client from CLI arguments or options
     * @param {object} config - Configuration object
     */
    configure(config) {
        // Validate and set host
        if (!config.host || !validateHost(config.host)) {
            throw new Error('Invalid or missing host');
        }
        this.host = config.host.startsWith('http') ? config.host : `https://${config.host}`;

        // Validate and set auth key
        if (!config.auth || !validateAuthKey(config.auth)) {
            throw new Error('Invalid or missing auth key');
        }
        this.authKey = config.auth;

        // Validate and set prefix
        if (config.prefix !== undefined) {
            if (!validatePrefix(config.prefix)) {
                throw new Error('Invalid prefix format');
            }
            this.prefix = config.prefix || '';
        }

        // Validate and set forward rules
        if (!config.forward || !Array.isArray(config.forward) || config.forward.length === 0) {
            throw new Error('At least one forward rule is required');
        }

        this.forwardRules = [];
        for (const rule of config.forward) {
            const parsed = validateForwardRule(rule);
            if (!parsed) {
                throw new Error(`Invalid forward rule: ${rule}`);
            }
            this.forwardRules.push(parsed);
        }

        // Validate and set concurrency
        if (config.concurrency && !validateConcurrency(config.concurrency)) {
            throw new Error('Invalid concurrency value');
        }
        this.concurrency = config.concurrency || 16;

        // Set optional parameters
        if (config.localHost) {
            this.localHost = config.localHost;
        }

        console.info(`Configured tunnel client:`);
        console.info(`  Host: ${this.host}`);
        console.info(`  Auth: ${this.authKey.substring(0, 4)}***`);
        if (this.prefix) {
            console.info(`  Prefix: /${this.prefix}`);
        }
        console.info(`  Forward rules: ${this.forwardRules.map(r => `${r.port}:${r.path}`).join(', ')}`);
        console.info(`  Concurrency: ${this.concurrency}`);
        console.info(`  Local host: ${this.localHost}`);
    }

    /**
     * Starts the tunnel client with race condition protection
     */
    async start() {
        // Prevent concurrent starts
        if (this.startPromise) {
            return this.startPromise;
        }

        if (this.isRunning) {
            throw new Error('Client is already running');
        }

        if (!this.host || this.forwardRules.length === 0 || !this.authKey) {
            throw new Error('Client must be configured before starting');
        }

        this.startPromise = this._performStart();
        return this.startPromise;
    }

    /**
     * Internal start implementation
     */
    async _performStart() {
        console.info('Starting tunnel client...');
        this.stats.startTime = Date.now();

        try {
            // Initialize components
            await this.initializeComponents();

            // Register tunnel with server
            await this.registerTunnel();

            // Start polling
            await this.poller.start();

            this.isRunning = true;
            console.info(`Tunnel client started successfully. Tunnel ID: ${this.tunnelId}`);
            console.info(`Public URL: ${this.host}`);

        } catch (error) {
            console.error('Failed to start tunnel client:', error.message);
            await this.cleanup();
            throw error;
        } finally {
            this.startPromise = null;
        }
    }

    /**
     * Stops the tunnel client
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        console.info('Stopping tunnel client...');
        this.isRunning = false;

        try {
            // Unregister tunnel
            if (this.tunnelId) {
                await this.unregisterTunnel();
            }

            // Stop components
            await this.cleanup();

            console.info('Tunnel client stopped successfully');
        } catch (error) {
            console.error('Error during shutdown:', error.message);
            throw error;
        }
    }

    /**
     * Initializes all client components
     */
    async initializeComponents() {
        // Create route matcher
        this.routeMatcher = new RouteMatcher(this.forwardRules);

        // Create worker pool
        this.workerPool = new WorkerPool(this.concurrency, {
            maxQueueSize: this.concurrency * 10,
            taskTimeout: this.streamTimeout, // Use stream timeout for large files
            enableBackpressure: true
        });

        // Create poller
        this.poller = new Poller(this.host, {
            concurrency: Math.min(this.concurrency, 8), // Limit polling connections
            timeout: 30000,
            maxRequestSize: this.maxRequestSize,
            authKey: this.authKey,
            prefix: this.prefix
        });

        // Set up poller dependencies
        this.poller.setWorkerPool(this.workerPool);
        this.poller.setRequestHandler(this.handleRequest.bind(this));
    }

    /**
   * Builds API URL with prefix support
   * @param {string} endpoint - API endpoint
   * @returns {string} - Full API URL
   */
    buildApiUrl(endpoint) {
        if (this.prefix) {
            const cleanPrefix = this.prefix.replace(/^\/+|\/+$/g, '');
            return `${this.host}/${cleanPrefix}/${endpoint}`;
        }
        return `${this.host}/${endpoint}`;
    }

    /**
     * Registers tunnel with the server
     */
    async registerTunnel() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        try {
            const response = await fetch(this.buildApiUrl('register'), {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.authKey}`,
                    'User-Agent': 'flarepipe-client/1.0.0'
                },
                body: JSON.stringify({
                    forward_rules: this.forwardRules,
                    client_info: {
                        version: '1.0.0',
                        concurrency: this.concurrency,
                        local_host: this.localHost,
                        features: {
                            compression: this.enableCompression,
                            streaming: true,
                            chunked_transfer: true,
                            max_request_size: this.maxRequestSize,
                            stream_threshold: this.streamThreshold
                        }
                    }
                })
            });

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    throw new Error(`Authentication failed: Invalid auth key`);
                }
                throw new Error(`Registration failed: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            if (!data.tunnel_id) {
                throw new Error('Server did not return tunnel ID');
            }

            this.tunnelId = data.tunnel_id;
            this.poller.setTunnelId(this.tunnelId);

            console.info(`Tunnel registered with ID: ${this.tunnelId}`);

            if (data.public_url) {
                console.info(`Public URL: ${data.public_url}`);
            }

        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Unregisters tunnel from the server
     */
    async unregisterTunnel() {
        if (!this.tunnelId) {
            return;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
            const response = fetch(this.buildApiUrl('unregister'), {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.authKey}`
                },
                body: JSON.stringify({
                    tunnel_id: this.tunnelId
                })
            });

            if (response.ok) {
                console.info('Tunnel unregistered successfully');
            } else {
                console.warn(`Failed to unregister tunnel: ${response.status}`);
            }
        } catch (error) {
            console.warn('Error unregistering tunnel:', error.message);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Handles incoming HTTP request from the server
     * @param {object} requestData - Request data from poller
     * @returns {object} - Response data
     */
    async handleRequest(requestData) {
        this.stats.requestsProcessed++;
        this.stats.lastRequestTime = Date.now();

        const startTime = Date.now();

        try {
            // Find matching route
            const route = this.routeMatcher.match(requestData.path);
            if (!route) {
                return this.createErrorResponse(404, 'Not Found', 'No matching route found');
            }

            // Check request size limits
            const bodySize = requestData.body ? requestData.body.length : 0;
            if (bodySize > this.maxRequestSize) {
                return this.createErrorResponse(413, 'Payload Too Large',
                    `Request body too large: ${bodySize} bytes (max: ${this.maxRequestSize})`);
            }

            // Proxy request to local server
            const response = await this.proxyToLocal(requestData, route);

            this.stats.requestsSucceeded++;
            this.stats.bytesTransferred += (response.body ? response.body.length : 0);

            const duration = Date.now() - startTime;
            console.info(`${requestData.method} ${requestData.path} -> ${route.port} (${response.status}) ${duration}ms`);

            return response;

        } catch (error) {
            this.stats.requestsFailed++;
            const duration = Date.now() - startTime;

            console.error(`${requestData.method} ${requestData.path} failed after ${duration}ms:`, error.message);

            return this.createErrorResponse(
                error.status || 500,
                error.statusText || 'Internal Server Error',
                `Proxy error: ${error.message}`
            );
        }
    }

    /**
     * Proxies request to local server with retry logic and improved error handling
     * @param {object} requestData - Original request data
     * @param {object} route - Matched route
     * @returns {object} - Response data
     */
    async proxyToLocal(requestData, route) {
        const targetUrl = `http://${this.localHost}:${route.port}${requestData.path}`;
        const query = requestData.query ? `?${requestData.query}` : '';
        const fullUrl = targetUrl + query;

        let lastError;

        for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
            let controller = null;

            try {
                controller = new AbortController();
                const response = await this.performRequest(fullUrl, requestData, route, controller);
                return response;

            } catch (error) {
                lastError = error;

                // Clean up controller
                if (controller && !controller.signal.aborted) {
                    try {
                        controller.abort();
                    } catch (abortError) {
                        // Ignore abort errors
                    }
                }

                // Don't retry on certain errors
                if (error.name === 'AbortError' ||
                    (error.status && error.status >= 400 && error.status < 500)) {
                    throw error;
                }

                if (attempt < this.retryAttempts) {
                    console.warn(`Attempt ${attempt} failed for ${requestData.method} ${requestData.path}, retrying...`);
                    await this.sleep(this.retryDelay * attempt);
                }
            }
        }

        // All attempts failed
        throw new Error(`Failed after ${this.retryAttempts} attempts: ${lastError.message}`);
    }

    /**
     * Performs single HTTP request with comprehensive timeout handling
     * @param {string} url - Target URL
     * @param {object} requestData - Request data
     * @param {object} route - Route information
     * @param {AbortController} controller - Abort controller
     * @returns {object} - Response data
     */
    async performRequest(url, requestData, route, controller) {
        // Overall timeout for the entire operation
        const overallTimeoutId = setTimeout(() => {
            controller.abort();
        }, this.requestTimeout);

        try {
            // Prepare headers
            const headers = { ...requestData.headers };

            // Set Host header appropriately for virtual hosts (case-insensitive check)
            const hostHeaderKey = Object.keys(requestData.headers).find(key =>
                key.toLowerCase() === 'host'
            );
            const hostHeaderValue = hostHeaderKey ? requestData.headers[hostHeaderKey] : null;

            if (hostHeaderValue) {
                headers['Host'] = hostHeaderValue;
            } else {
                headers['Host'] = `${this.localHost}:${route.port}`;
            }

            // Add compression support
            if (this.enableCompression && !headers['accept-encoding']) {
                headers['Accept-Encoding'] = 'gzip, deflate';
            }

            // Remove problematic headers that fetch will handle
            delete headers['content-length'];
            delete headers['connection'];
            delete headers['transfer-encoding'];

            const response = await fetch(url, {
                method: requestData.method,
                signal: controller.signal,
                headers: headers,
                body: requestData.body || undefined
            });

            // Process response with intelligent streaming
            return await this.processResponseIntelligently(response, controller);

        } finally {
            clearTimeout(overallTimeoutId);
        }
    }

    /**
     * Intelligently processes response based on content type and size
     * @param {Response} response - Fetch response
     * @param {AbortController} controller - Abort controller
     * @returns {object} - Processed response data
     */
    async processResponseIntelligently(response, controller) {
        // Collect response headers
        const responseHeaders = {};
        for (const [key, value] of response.headers.entries()) {
            responseHeaders[key] = value;
        }

        const contentLength = this.parseContentLength(response.headers.get('content-length'));
        const contentType = response.headers.get('content-type') || '';
        const contentEncoding = response.headers.get('content-encoding') || '';

        // Detect if content is binary based on multiple factors
        const isBinary = this.detectBinaryContent(contentType, response.headers);

        // Determine processing strategy
        const shouldStream = this.shouldUseStreaming(contentLength, isBinary, contentEncoding);

        let body;

        if (shouldStream) {
            // Use memory-efficient streaming for large content
            body = await this.processStreamingResponse(response, controller, isBinary);
            this.stats.streamsProcessed++;
        } else {
            // Load smaller content into memory
            body = await this.processBufferedResponse(response, isBinary);
        }

        return {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: body || ''
        };
    }

    /**
     * Safely parses content-length header
     * @param {string} contentLengthHeader - Content-Length header value
     * @returns {number} - Parsed content length or 0
     */
    parseContentLength(contentLengthHeader) {
        if (!contentLengthHeader) return 0;
        const parsed = parseInt(contentLengthHeader, 10);
        return isNaN(parsed) ? 0 : parsed;
    }

    /**
     * Detects if content is binary based on multiple signals
     * @param {string} contentType - Content-Type header
     * @param {Headers} headers - Response headers
     * @returns {boolean} - True if content is likely binary
     */
    detectBinaryContent(contentType, headers) {
        // Normalize content type by extracting main type before semicolon
        const mainContentType = contentType.split(';')[0].trim().toLowerCase();

        // Text content types
        const textTypes = [
            'text/',
            'application/json',
            'application/xml',
            'application/javascript',
            'application/x-javascript',
            'application/ecmascript',
            'application/rss+xml',
            'application/atom+xml'
        ];

        if (textTypes.some(type => mainContentType.includes(type))) {
            return false;
        }

        // Binary content types
        const binaryTypes = [
            'image/',
            'video/',
            'audio/',
            'application/octet-stream',
            'application/pdf',
            'application/zip',
            'application/x-rar-compressed',
            'application/x-tar',
            'application/x-gzip'
        ];

        if (binaryTypes.some(type => mainContentType.includes(type))) {
            return true;
        }

        // If no content-type or unknown, assume text for safety
        return false;
    }

    /**
     * Determines if streaming should be used
     * @param {number} contentLength - Content length
     * @param {boolean} isBinary - Is binary content
     * @param {string} contentEncoding - Content encoding
     * @returns {boolean} - True if streaming should be used
     */
    shouldUseStreaming(contentLength, isBinary, contentEncoding) {
        // Always stream if content-length is above threshold
        if (contentLength > this.streamThreshold) {
            return true;
        }

        // Stream compressed content regardless of size (can't trust content-length)
        if (contentEncoding && contentEncoding !== 'identity') {
            return true;
        }

        // Stream binary content above a smaller threshold
        if (isBinary && contentLength > this.streamThreshold / 4) {
            return true;
        }

        return false;
    }

    /**
     * Processes response using memory-efficient streaming with fallback
     * @param {Response} response - Fetch response
     * @param {AbortController} controller - Abort controller
     * @param {boolean} isBinary - Is binary content
     * @returns {string} - Processed response body
     */
    async processStreamingResponse(response, controller, isBinary) {
        try {
            return await this.attemptStreamingRead(response, controller, isBinary);
        } catch (error) {
            // Fallback to buffered approach if streaming fails
            console.warn('Streaming failed, falling back to buffered read:', error.message);
            return await this.processBufferedResponse(response, isBinary);
        }
    }

    /**
     * Attempts to read response using streaming
     * @param {Response} response - Fetch response
     * @param {AbortController} controller - Abort controller
     * @param {boolean} isBinary - Is binary content
     * @returns {string} - Processed response body
     */
    async attemptStreamingRead(response, controller, isBinary) {
        const reader = response.body.getReader();
        const chunks = [];
        let totalSize = 0;

        // Adaptive stream timeout based on expected size
        const streamTimeout = Math.max(30000, Math.min(this.streamTimeout, 300000)); // 30s to 5min
        let streamTimeoutId = null;

        const resetStreamTimeout = () => {
            if (streamTimeoutId) {
                clearTimeout(streamTimeoutId);
            }
            streamTimeoutId = setTimeout(() => {
                controller.abort();
            }, streamTimeout);
        };

        try {
            resetStreamTimeout();

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                totalSize += value.length;

                // Check size limits
                if (totalSize > this.maxStreamSize) {
                    throw new Error(`Response stream too large: ${totalSize} bytes (max: ${this.maxStreamSize})`);
                }

                chunks.push(value);

                // Reset timeout on each successful read
                resetStreamTimeout();

                // Memory pressure relief - if we have too many chunks, combine them
                if (chunks.length > 100) {
                    const combined = this.combineChunks(chunks.splice(0, 50));
                    chunks.unshift(combined);
                }
            }

            // Combine all chunks efficiently
            const finalBuffer = this.combineChunks(chunks);

            // Clear chunks to help GC
            chunks.length = 0;

            if (isBinary) {
                return Buffer.from(finalBuffer).toString('base64');
            } else {
                // Safe text decoding with error handling
                try {
                    return new TextDecoder('utf-8', { fatal: false }).decode(finalBuffer);
                } catch (decodeError) {
                    // Fallback to binary handling if text decoding fails
                    return Buffer.from(finalBuffer).toString('base64');
                }
            }

        } finally {
            if (streamTimeoutId) {
                clearTimeout(streamTimeoutId);
            }

            try {
                reader.releaseLock();
            } catch (error) {
                // Ignore release errors
            }
        }
    }

    /**
     * Efficiently combines chunks into a single buffer
     * @param {Array} chunks - Array of Uint8Array chunks
     * @returns {Uint8Array} - Combined buffer
     */
    combineChunks(chunks) {
        if (chunks.length === 0) return new Uint8Array(0);
        if (chunks.length === 1) return chunks[0];

        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        return combined;
    }

    /**
     * Processes smaller responses by loading into memory
     * @param {Response} response - Fetch response
     * @param {boolean} isBinary - Is binary content
     * @returns {string} - Response body
     */
    async processBufferedResponse(response, isBinary) {
        if (isBinary) {
            const buffer = await response.arrayBuffer();
            return Buffer.from(buffer).toString('base64');
        } else {
            return await response.text();
        }
    }

    /**
     * Creates error response
     * @param {number} status - HTTP status code
     * @param {string} statusText - HTTP status text
     * @param {string} message - Error message
     * @returns {object} - Error response
     */
    createErrorResponse(status, statusText, message) {
        return {
            status,
            statusText,
            headers: {
                'Content-Type': 'text/plain',
                'X-Tunnel-Error': 'true'
            },
            body: message
        };
    }

    /**
     * Cleanup all resources
     */
    async cleanup() {
        const cleanupPromises = [];

        if (this.poller) {
            cleanupPromises.push(this.poller.stop().catch(err =>
                console.warn('Error stopping poller:', err.message)
            ));
        }

        if (this.workerPool) {
            cleanupPromises.push(this.workerPool.shutdown(5000).catch(err =>
                console.warn('Error shutting down worker pool:', err.message)
            ));
        }

        await Promise.allSettled(cleanupPromises);

        this.poller = null;
        this.workerPool = null;
        this.routeMatcher = null;
        this.tunnelId = null;
        this.startPromise = null;
    }

    /**
     * Gets current client status
     * @returns {object} - Status information
     */
    getStatus() {
        const uptime = this.stats.startTime ? Date.now() - this.stats.startTime : 0;
        const requestRate = uptime > 0 ? (this.stats.requestsProcessed / (uptime / 1000)).toFixed(2) : '0.00';

        return {
            isRunning: this.isRunning,
            tunnelId: this.tunnelId,
            host: this.host,
            forwardRules: this.forwardRules,
            uptime: uptime,
            stats: {
                ...this.stats,
                requestRate: `${requestRate} req/s`,
                successRate: this.stats.requestsProcessed > 0 ?
                    `${((this.stats.requestsSucceeded / this.stats.requestsProcessed) * 100).toFixed(1)}%` : '0%',
                streamingRate: this.stats.requestsProcessed > 0 ?
                    `${((this.stats.streamsProcessed / this.stats.requestsProcessed) * 100).toFixed(1)}%` : '0%'
            },
            poller: this.poller ? this.poller.getStatus() : null,
            workerPool: this.workerPool ? this.workerPool.getStatus() : null
        };
    }

    /**
     * Sleep utility function
     * @param {number} ms - Milliseconds to sleep
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = TunnelClient;