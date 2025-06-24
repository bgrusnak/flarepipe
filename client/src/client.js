// client/src/client.js

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
        this.requestTimeout = options.requestTimeout || 120000; // 120 seconds
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
     * Initializes all client components with enhanced error handling
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

        // Create poller with enhanced configuration
        this.poller = new Poller(this.host, {
            concurrency: Math.min(this.concurrency, 8), // Limit polling connections
            timeout: 30000,
            maxRequestSize: this.maxRequestSize,
            authKey: this.authKey,
            prefix: this.prefix,
            retryDelay: 1000,
            maxRetryDelay: 30000
        });

        // Set up poller dependencies
        this.poller.setWorkerPool(this.workerPool);
        this.poller.setRequestHandler(this.handleRequest.bind(this));
        this.poller.setClient(this); // NEW: For auto-reconnect
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
     * Enhanced tunnel registration with better error handling
     */
    async registerTunnel() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // Increased timeout

        try {
            console.info('Registering tunnel with server...');
            
            const response = await fetch(this.buildApiUrl('register'), {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.authKey}`,
                    'User-Agent': 'flarepipe-client/1.2.0'
                },
                body: JSON.stringify({
                    forward_rules: this.forwardRules,
                    client_info: {
                        version: '1.2.0',
                        concurrency: this.concurrency,
                        local_host: this.localHost,
                        features: {
                            raw_binary: true,
                            chunked_transfer: true,
                            max_request_size: this.maxRequestSize,
                            max_response_size: this.maxResponseSize,
                            durable_objects: true // NEW: Indicate DO support
                        }
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                
                if (response.status === 401 || response.status === 403) {
                    throw new Error(`Authentication failed: Invalid auth key`);
                }
                
                if (response.status === 429) {
                    throw new Error(`Server overloaded: Too many tunnels. Try again later.`);
                }
                
                let errorMessage = `Registration failed: ${response.status} ${response.statusText}`;
                try {
                    const errorData = JSON.parse(errorText);
                    if (errorData.error) {
                        errorMessage = errorData.error;
                    }
                } catch (e) {
                    // Use default error message
                }
                
                throw new Error(errorMessage);
            }

            const data = await response.json();

            if (!data.tunnel_id) {
                throw new Error('Server did not return tunnel ID');
            }

            this.tunnelId = data.tunnel_id;
            this.poller.setTunnelId(this.tunnelId);

            console.info(`✅ Tunnel registered successfully:`);
            console.info(`   Tunnel ID: ${this.tunnelId}`);
            console.info(`   Rules: ${data.rules_registered} forwarding rules`);
            console.info(`   Expires: ${Math.round(data.expires_in / 1000 / 60)} minutes`);
            
            if (data.replaced_tunnels > 0) {
                console.info(`   Replaced: ${data.replaced_tunnels} existing tunnels`);
            }

            if (data.public_url) {
                console.info(`   Public URL: ${data.public_url}`);
            }

        } catch (error) {
            console.error('Failed to register tunnel:', error.message);
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Enhanced unregistration with proper error handling
     */
    async unregisterTunnel() {
        if (!this.tunnelId) {
            console.info('No active tunnel to unregister');
            return;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
            console.info(`Unregistering tunnel: ${this.tunnelId}`);
            
            const response = await fetch(this.buildApiUrl('unregister'), {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.authKey}`,
                    'User-Agent': 'flarepipe-client/1.2.0'
                },
                body: JSON.stringify({
                    tunnel_id: this.tunnelId
                })
            });

            if (response.ok) {
                console.info('✅ Tunnel unregistered successfully');
            } else {
                const errorText = await response.text();
                console.warn(`Failed to unregister tunnel: ${response.status} - ${errorText}`);
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.warn('Error unregistering tunnel:', error.message);
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Enhanced error handling for requests
     */
    async handleRequest(requestData) {
        this.stats.requestsProcessed++;
        this.stats.lastRequestTime = Date.now();

        const startTime = Date.now();

        try {
            // Validate request data
            if (!requestData || !requestData.id || !requestData.method || !requestData.path) {
                throw new Error('Invalid request data received');
            }

            // Find matching route
            const route = this.routeMatcher.match(requestData.path);
            if (!route) {
                return this.createErrorResponse(404, 'Not Found', 
                    `No forwarding rule matches path: ${requestData.path}`);
            }

            // Check request size limits
            const bodySize = requestData.body ? 
                (requestData.body instanceof ArrayBuffer ? requestData.body.byteLength : requestData.body.length) : 0;
            if (bodySize > this.maxRequestSize) {
                return this.createErrorResponse(413, 'Payload Too Large',
                    `Request body too large: ${bodySize} bytes (max: ${this.maxRequestSize})`);
            }

            // Log request
            console.info(`📨 ${requestData.method} ${requestData.path} → localhost:${route.port}`);

            // Proxy request to local server
            const response = await this.proxyToLocal(requestData, route);

            this.stats.requestsSucceeded++;
            this.stats.bytesTransferred += (response.body ? response.body.byteLength : 0);

            const duration = Date.now() - startTime;
            console.info(`✅ ${requestData.method} ${requestData.path} → ${route.port} (${response.status}) ${duration}ms`);

            return response;

        } catch (error) {
            this.stats.requestsFailed++;
            const duration = Date.now() - startTime;

            console.error(`❌ ${requestData.method} ${requestData.path} failed after ${duration}ms:`, error.message);

            // Provide helpful error messages
            if (error.message.includes('ECONNREFUSED')) {
                return this.createErrorResponse(503, 'Service Unavailable',
                    `Cannot connect to localhost:${route?.port}. Is your development server running?`);
            }

            if (error.message.includes('ENOTFOUND')) {
                return this.createErrorResponse(502, 'Bad Gateway',
                    `Cannot resolve localhost. Check your network configuration.`);
            }

            if (error.message.includes('timeout')) {
                return this.createErrorResponse(504, 'Gateway Timeout',
                    `Local server took too long to respond (>${this.requestTimeout}ms).`);
            }

            return this.createErrorResponse(
                error.status || 500,
                error.statusText || 'Internal Server Error',
                `Proxy error: ${error.message}`
            );
        }
    }

    /**
     * ИСПРАВЛЕНО: Proxies request to local server - retry ONLY on timeouts
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

                // ИСПРАВЛЕНИЕ: Retry ТОЛЬКО при таймаутах
                const isTimeoutError = error.name === 'AbortError' || 
                                     error.message.includes('timeout') ||
                                     error.message.includes('ETIMEDOUT') ||
                                     error.code === 'ETIMEDOUT';

                if (!isTimeoutError) {
                    // Для всех остальных ошибок - немедленно возвращаем без retry
                    throw error;
                }

                // Retry только для таймаутов
                if (attempt < this.retryAttempts) {
                    console.warn(`Timeout on attempt ${attempt} for ${requestData.method} ${requestData.path}, retrying...`);
                    await this.sleep(this.retryDelay * attempt);
                } else {
                    console.warn(`All ${this.retryAttempts} attempts timed out for ${requestData.method} ${requestData.path}`);
                }
            }
        }

        // Все попытки завершились таймаутом
        throw new Error(`Request timed out after ${this.retryAttempts} attempts: ${lastError.message}`);
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
     * Enhanced status display
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
            version: '1.2.0',
            durableObjects: true, // NEW: Indicate DO support
            stats: {
                ...this.stats,
                requestRate: `${requestRate} req/s`,
                successRate: this.stats.requestsProcessed > 0 ?
                    `${((this.stats.requestsSucceeded / this.stats.requestsProcessed) * 100).toFixed(1)}%` : '0%',
                avgResponseTime: this.stats.requestsProcessed > 0 ?
                    `${Math.round((Date.now() - this.stats.startTime) / this.stats.requestsProcessed)}ms` : '0ms'
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