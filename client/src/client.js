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
        this.maxResponseSize = options.maxResponseSize || 100 * 1024 * 1024; // 100MB max
        this.retryAttempts = options.retryAttempts || 3;
        this.retryDelay = options.retryDelay || 1000;

        // Statistics
        this.stats = {
            requestsProcessed: 0,
            requestsSucceeded: 0,
            requestsFailed: 0,
            bytesTransferred: 0,
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
            taskTimeout: this.requestTimeout,
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
                            raw_binary: true,
                            chunked_transfer: true,
                            max_request_size: this.maxRequestSize,
                            max_response_size: this.maxResponseSize
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
            const bodySize = requestData.body ? 
                (requestData.body instanceof ArrayBuffer ? requestData.body.byteLength : requestData.body.length) : 0;
            if (bodySize > this.maxRequestSize) {
                return this.createErrorResponse(413, 'Payload Too Large',
                    `Request body too large: ${bodySize} bytes (max: ${this.maxRequestSize})`);
            }

            // Proxy request to local server
            const response = await this.proxyToLocal(requestData, route);

            this.stats.requestsSucceeded++;
            this.stats.bytesTransferred += (response.body ? response.body.byteLength : 0);

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
     * Proxies request to local server with retry logic
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
     * Performs single HTTP request with timeout handling
     * @param {string} url - Target URL
     * @param {object} requestData - Request data
     * @param {object} route - Route information
     * @param {AbortController} controller - Abort controller
     * @returns {object} - Response data with ArrayBuffer body
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

        // Remove problematic headers that fetch will handle
        delete headers['content-length'];
        delete headers['connection'];
        delete headers['transfer-encoding'];

        // Prepare fetch options
        const fetchOptions = {
            method: requestData.method,
            signal: controller.signal,
            headers: headers
        };

        // Only add body for methods that support it
        if (requestData.method !== 'GET' && requestData.method !== 'HEAD') {
            fetchOptions.body = requestData.body;
        }

        const response = await fetch(url, fetchOptions);

        // Process response - ALL DATA AS RAW BINARY (ArrayBuffer)
        return await this.processResponse(response);

    } finally {
        clearTimeout(overallTimeoutId);
    }
}

    /**
     * Processes response and returns RAW BINARY data as ArrayBuffer
     * @param {Response} response - Fetch response
     * @returns {object} - Response data with ArrayBuffer body
     */
    async processResponse(response) {
        // Collect response headers
        const responseHeaders = {};
        for (const [key, value] of response.headers.entries()) {
            responseHeaders[key] = value;
        }

        // Check response size
        const contentLength = response.headers.get('content-length');
        if (contentLength) {
            const size = parseInt(contentLength, 10);
            if (size > this.maxResponseSize) {
                throw new Error(`Response too large: ${size} bytes (max: ${this.maxResponseSize})`);
            }
        }

        // Get response body as RAW BINARY (ArrayBuffer)
        const body = await response.arrayBuffer();

        // Final size check
        if (body.byteLength > this.maxResponseSize) {
            throw new Error(`Response too large: ${body.byteLength} bytes (max: ${this.maxResponseSize})`);
        }

        return {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: body // ArrayBuffer - RAW BINARY
        };
    }

    /**
     * Creates error response
     * @param {number} status - HTTP status code
     * @param {string} statusText - HTTP status text
     * @param {string} message - Error message
     * @returns {object} - Error response with ArrayBuffer body
     */
    createErrorResponse(status, statusText, message) {
        // Convert error message to ArrayBuffer
        const encoder = new TextEncoder();
        const body = encoder.encode(message).buffer;

        return {
            status,
            statusText,
            headers: {
                'Content-Type': 'text/plain',
                'X-Tunnel-Error': 'true'
            },
            body: body // ArrayBuffer
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
                    `${((this.stats.requestsSucceeded / this.stats.requestsProcessed) * 100).toFixed(1)}%` : '0%'
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