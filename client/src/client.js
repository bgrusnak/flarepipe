const Poller = require('./poller');
const WorkerPool = require('./worker-pool');
const RouteMatcher = require('./route-matcher');
const { validateHost, validateForwardRule, validateConcurrency, validateAuthKey, validatePrefix } = require('./utils/validator');

class TunnelClient {
    constructor(options = {}) {
        this.host = null;
        this.authKey = null;
        this.prefix = '';
        this.forwardRules = [];
        this.concurrency = 8; // Уменьшено по умолчанию
        this.localHost = 'localhost';
        this.tunnelId = null;
        this.isRunning = false;
        this.startPromise = null;

        // Components
        this.poller = null;
        this.workerPool = null;
        this.routeMatcher = null;

        // Агрессивно уменьшенные таймауты
        this.requestTimeout = options.requestTimeout || 45000; // 45 секунд
        this.maxRequestSize = options.maxRequestSize || 2 * 1024 * 1024; // 2MB
        this.maxResponseSize = options.maxResponseSize || 10 * 1024 * 1024; // 10MB
        this.retryAttempts = options.retryAttempts || 3; // Уменьшено
        this.retryDelay = options.retryDelay || 500; // Уменьшено

        // Enhanced connection management
        this.connectionHealth = {
            consecutiveErrors: 0,
            lastSuccessTime: Date.now(),
            reconnectAttempts: 0,
            maxReconnectAttempts: 5,
            backoffMultiplier: 1.5,
            maxBackoffDelay: 10000
        };

        // Circuit breaker for local requests
        this.circuitBreaker = {
            isOpen: false,
            failureCount: 0,
            failureThreshold: 5,
            resetTimeout: 30000,
            lastFailureTime: 0
        };

        // Statistics
        this.stats = {
            requestsProcessed: 0,
            requestsSucceeded: 0,
            requestsFailed: 0,
            bytesTransferred: 0,
            startTime: null,
            lastRequestTime: null,
            connectionDrops: 0,
            timeouts: 0,
            localErrors: 0
        };
    }

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

        // Validate and set concurrency (уменьшенное по умолчанию)
        if (config.concurrency && !validateConcurrency(config.concurrency)) {
            throw new Error('Invalid concurrency value');
        }
        this.concurrency = Math.min(config.concurrency || 8, 12); // Максимум 12

        // Set optional parameters
        if (config.localHost) {
            this.localHost = config.localHost;
        }

        console.info(`Configured optimized tunnel client:`);
        console.info(`  Host: ${this.host}`);
        console.info(`  Auth: ${this.authKey.substring(0, 4)}***`);
        if (this.prefix) {
            console.info(`  Prefix: /${this.prefix}`);
        }
        console.info(`  Forward rules: ${this.forwardRules.map(r => `${r.port}:${r.path}`).join(', ')}`);
        console.info(`  Concurrency: ${this.concurrency} (optimized)`);
        console.info(`  Local host: ${this.localHost}`);
        console.info(`  Request timeout: ${this.requestTimeout}ms`);
    }

    async start() {
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

    async _performStart() {
        console.info('Starting optimized tunnel client...');
        this.stats.startTime = Date.now();

        try {
            // Initialize components with optimized settings
            await this.initializeOptimizedComponents();

            // Register tunnel with server
            await this.registerTunnel();

            // Start polling
            await this.poller.start();

            this.isRunning = true;
            this.connectionHealth.lastSuccessTime = Date.now();
            console.info(`✅ Optimized tunnel client started successfully. Tunnel ID: ${this.tunnelId}`);
            console.info(`🔗 Public URL: ${this.host}`);

        } catch (error) {
            console.error('❌ Failed to start tunnel client:', error.message);
            await this.cleanup();
            throw error;
        } finally {
            this.startPromise = null;
        }
    }

    async stop() {
        if (!this.isRunning) {
            return;
        }

        console.info('Stopping optimized tunnel client...');
        this.isRunning = false;

        try {
            if (this.tunnelId) {
                await this.unregisterTunnel();
            }

            await this.cleanup();
            console.info('✅ Tunnel client stopped successfully');
        } catch (error) {
            console.error('Error during shutdown:', error.message);
            throw error;
        }
    }

    async initializeOptimizedComponents() {
        // Create route matcher
        this.routeMatcher = new RouteMatcher(this.forwardRules);

        // Create optimized worker pool
        this.workerPool = new WorkerPool(this.concurrency, {
            maxQueueSize: Math.max(this.concurrency * 3, 10), // Уменьшено
            taskTimeout: this.requestTimeout,
            enableBackpressure: true,
            backpressureThreshold: 0.7, // Более агрессивный backpressure
            maxErrorsPerWindow: 3, // Уменьшено
            degradationFactor: 0.3 // Более агрессивная деградация
        });

        // Create optimized poller
        this.poller = new Poller(this.host, {
            concurrency: Math.min(this.concurrency, 4), // Ограничено 4 соединениями
            timeout: 15000, // Уменьшен таймаут polling
            maxRequestSize: this.maxRequestSize,
            authKey: this.authKey,
            prefix: this.prefix,
            retryDelay: 500, // Уменьшена задержка
            maxRetryDelay: 5000, // Уменьшена максимальная задержка
            heartbeatInterval: 30000 // Более частые heartbeat
        });

        // Set up poller dependencies
        this.poller.setWorkerPool(this.workerPool);
        this.poller.setRequestHandler(this.handleRequestWithCircuitBreaker.bind(this));
        this.poller.setClient(this);
    }

    buildApiUrl(endpoint) {
        if (this.prefix) {
            const cleanPrefix = this.prefix.replace(/^\/+|\/+$/g, '');
            return `${this.host}/${cleanPrefix}/${endpoint}`;
        }
        return `${this.host}/${endpoint}`;
    }

    async registerTunnel() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // Уменьшен таймаут

        try {
            console.info('Registering tunnel with server...');
            
            const response = await fetch(this.buildApiUrl('register'), {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.authKey}`,
                    'User-Agent': 'flarepipe-client/2.0.3-optimized'
                },
                body: JSON.stringify({
                    forward_rules: this.forwardRules,
                    client_info: {
                        version: '2.0.3-optimized',
                        concurrency: this.concurrency,
                        local_host: this.localHost,
                        features: {
                            raw_binary: true,
                            chunked_transfer: true,
                            max_request_size: this.maxRequestSize,
                            max_response_size: this.maxResponseSize,
                            optimized: true,
                            circuit_breaker: true,
                            connection_health: true
                        }
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                
                if (response.status === 401 || response.status === 403) {
                    throw new Error(`Authentication failed: Invalid auth key`);
                }
                
                if (response.status === 429 || response.status === 503) {
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

            // Reset connection health on successful registration
            this.connectionHealth.consecutiveErrors = 0;
            this.connectionHealth.reconnectAttempts = 0;
            this.connectionHealth.lastSuccessTime = Date.now();

            console.info(`✅ Tunnel registered successfully:`);
            console.info(`   Tunnel ID: ${this.tunnelId}`);
            console.info(`   Rules: ${data.rules_registered} forwarding rules`);
            console.info(`   Expires: ${Math.round(data.expires_in / 1000 / 60)} minutes`);
            
            if (data.replaced_tunnels > 0) {
                console.info(`   Replaced: ${data.replaced_tunnels} existing tunnels`);
            }

        } catch (error) {
            this.connectionHealth.consecutiveErrors++;
            console.error('Failed to register tunnel:', error.message);
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async unregisterTunnel() {
        if (!this.tunnelId) {
            console.info('No active tunnel to unregister');
            return;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // Быстрый таймаут

        try {
            console.info(`Unregistering tunnel: ${this.tunnelId}`);
            
            const response = await fetch(this.buildApiUrl('unregister'), {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.authKey}`,
                    'User-Agent': 'flarepipe-client/2.0.3-optimized'
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

    async handleRequestWithCircuitBreaker(requestData) {
        this.stats.requestsProcessed++;
        this.stats.lastRequestTime = Date.now();

        // Check circuit breaker
        if (this.isCircuitBreakerOpen()) {
            this.stats.requestsFailed++;
            console.warn(`Circuit breaker open, rejecting request ${requestData.id}`);
            
            return this.createErrorResponse(503, 'Service Unavailable', 
                'Local services temporarily unavailable (circuit breaker open)');
        }

        const startTime = Date.now();

        try {
            const response = await this.handleRequest(requestData);
            
            // Record success
            this.recordCircuitBreakerSuccess();
            this.connectionHealth.lastSuccessTime = Date.now();
            this.connectionHealth.consecutiveErrors = 0;
            
            return response;

        } catch (error) {
            this.recordCircuitBreakerFailure();
            this.connectionHealth.consecutiveErrors++;
            
            const duration = Date.now() - startTime;
            console.error(`❌ ${requestData.method} ${requestData.path} failed after ${duration}ms:`, error.message);

            // Specific error handling
            if (error.message.includes('ECONNREFUSED')) {
                this.stats.localErrors++;
                return this.createErrorResponse(503, 'Service Unavailable',
                    `Cannot connect to localhost:${this.getPortFromRequest(requestData)}. Is your service running?`);
            }

            return this.createErrorResponse(
                error.status || 500,
                error.statusText || 'Internal Server Error',
                `Request failed: ${error.message}`
            );
        }
    }

    async handleRequest(requestData) {
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

        // Proxy request to local server with optimized settings
        const response = await this.proxyToLocalOptimized(requestData, route);

        this.stats.requestsSucceeded++;
        this.stats.bytesTransferred += (response.body ? response.body.byteLength : 0);

        const duration = Date.now() - requestData.timestamp;
        console.info(`✅ ${requestData.method} ${requestData.path} → ${route.port} (${response.status}) ${duration}ms`);

        return response;
    }

    async proxyToLocalOptimized(requestData, route) {
        const targetUrl = `http://${this.localHost}:${route.port}${requestData.path}`;
        const query = requestData.query ? `?${requestData.query}` : '';
        const fullUrl = targetUrl + query;

        let lastError;

        for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
            let controller = null;

            try {
                controller = new AbortController();
                
                // Более агрессивный таймаут
                const timeoutId = setTimeout(() => {
                    controller.abort();
                }, Math.min(this.requestTimeout, 30000)); // Максимум 30 секунд

                try {
                    const response = await this.performOptimizedRequest(fullUrl, requestData, route, controller);
                    clearTimeout(timeoutId);
                    return response;
                } finally {
                    clearTimeout(timeoutId);
                }

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
                    const delay = Math.min(this.retryDelay * attempt, 2000); // Максимум 2 секунды
                    console.warn(`Attempt ${attempt} failed for ${requestData.method} ${targetUrl}, retrying in ${delay}ms...`);
                    console.error(error);
                    await this.sleep(delay);
                }
            }
        }

        // All attempts failed
        throw new Error(`Failed after ${this.retryAttempts} attempts: ${lastError.message}`);
    }
    
    async performOptimizedRequest(url, requestData, route, controller) {
        // Prepare headers
        const headers = { ...requestData.headers };

        // Set Host header appropriately
        const hostHeaderKey = Object.keys(requestData.headers).find(key =>
            key.toLowerCase() === 'host'
        );
        const hostHeaderValue = hostHeaderKey ? requestData.headers[hostHeaderKey] : null;

        if (hostHeaderValue) {
            headers['Host'] = hostHeaderValue;
        } else {
            headers['Host'] = `${this.localHost}:${route.port}`;
        }

        // Remove problematic headers
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

        // Process response
        return await this.processOptimizedResponse(response);
    }

    async processOptimizedResponse(response) {
        // Collect response headers
        const responseHeaders = {};
        for (const [key, value] of response.headers.entries()) {
            responseHeaders[key] = value;
        }

        // Early size check from headers
        const contentLength = response.headers.get('content-length');
        if (contentLength) {
            const size = parseInt(contentLength, 10);
            if (size > this.maxResponseSize) {
                throw new Error(`Response too large: ${size} bytes (max: ${this.maxResponseSize})`);
            }
        }

        // Get response body as RAW BINARY (ArrayBuffer) with streaming if large
        let body;
        
        if (contentLength && parseInt(contentLength, 10) > 1024 * 1024) {
            // Stream large responses
            body = await this.streamLargeResponse(response);
        } else {
            body = await response.arrayBuffer();
        }

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

    async streamLargeResponse(response) {
        const reader = response.body.getReader();
        const chunks = [];
        let totalSize = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                
                if (done) break;
                
                totalSize += value.byteLength;
                if (totalSize > this.maxResponseSize) {
                    throw new Error(`Response too large during streaming: ${totalSize} bytes`);
                }
                
                chunks.push(value);
            }

            // Combine chunks into single ArrayBuffer
            const combinedArray = new Uint8Array(totalSize);
            let offset = 0;
            
            for (const chunk of chunks) {
                combinedArray.set(chunk, offset);
                offset += chunk.byteLength;
            }

            return combinedArray.buffer;
            
        } finally {
            reader.releaseLock();
        }
    }

    // Circuit breaker methods
    isCircuitBreakerOpen() {
        const now = Date.now();
        
        if (this.circuitBreaker.isOpen) {
            // Check if reset timeout has passed
            if (now - this.circuitBreaker.lastFailureTime > this.circuitBreaker.resetTimeout) {
                this.circuitBreaker.isOpen = false;
                this.circuitBreaker.failureCount = 0;
                console.info('Circuit breaker reset - attempting to restore service');
                return false;
            }
            return true;
        }
        
        return false;
    }

    recordCircuitBreakerFailure() {
        this.circuitBreaker.failureCount++;
        this.circuitBreaker.lastFailureTime = Date.now();
        
        if (this.circuitBreaker.failureCount >= this.circuitBreaker.failureThreshold) {
            this.circuitBreaker.isOpen = true;
            console.warn(`Circuit breaker opened after ${this.circuitBreaker.failureCount} failures`);
        }
    }

    recordCircuitBreakerSuccess() {
        this.circuitBreaker.failureCount = 0;
        if (this.circuitBreaker.isOpen) {
            this.circuitBreaker.isOpen = false;
            console.info('Circuit breaker closed - service restored');
        }
    }

    getPortFromRequest(requestData) {
        const route = this.routeMatcher.match(requestData.path);
        return route ? route.port : 'unknown';
    }

    createErrorResponse(status, statusText, message) {
        const encoder = new TextEncoder();
        const body = encoder.encode(message).buffer;

        return {
            status,
            statusText,
            headers: {
                'Content-Type': 'text/plain',
                'X-Tunnel-Error': 'true',
                'X-Error-Type': status >= 500 ? 'server-error' : 'client-error'
            },
            body: body // ArrayBuffer
        };
    }

    async cleanup() {
        const cleanupPromises = [];

        if (this.poller) {
            cleanupPromises.push(this.poller.stop().catch(err =>
                console.warn('Error stopping poller:', err.message)
            ));
        }

        if (this.workerPool) {
            cleanupPromises.push(this.workerPool.shutdown(3000).catch(err =>
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

    getStatus() {
        const uptime = this.stats.startTime ? Date.now() - this.stats.startTime : 0;
        const requestRate = uptime > 0 ? (this.stats.requestsProcessed / (uptime / 1000)).toFixed(2) : '0.00';

        return {
            isRunning: this.isRunning,
            tunnelId: this.tunnelId,
            host: this.host,
            forwardRules: this.forwardRules,
            uptime: uptime,
            version: '2.0.3-optimized',
            optimized: true,
            
            // Enhanced stats
            stats: {
                ...this.stats,
                requestRate: `${requestRate} req/s`,
                successRate: this.stats.requestsProcessed > 0 ?
                    `${((this.stats.requestsSucceeded / this.stats.requestsProcessed) * 100).toFixed(1)}%` : '0%',
                timeoutRate: this.stats.requestsProcessed > 0 ?
                    `${((this.stats.timeouts / this.stats.requestsProcessed) * 100).toFixed(1)}%` : '0%',
                localErrorRate: this.stats.requestsProcessed > 0 ?
                    `${((this.stats.localErrors / this.stats.requestsProcessed) * 100).toFixed(1)}%` : '0%'
            },
            
            // Connection health
            connectionHealth: {
                ...this.connectionHealth,
                timeSinceLastSuccess: Date.now() - this.connectionHealth.lastSuccessTime,
                isHealthy: this.connectionHealth.consecutiveErrors < 3 && 
                          (Date.now() - this.connectionHealth.lastSuccessTime) < 60000
            },
            
            // Circuit breaker status
            circuitBreaker: {
                isOpen: this.circuitBreaker.isOpen,
                failureCount: this.circuitBreaker.failureCount,
                timeSinceLastFailure: this.circuitBreaker.lastFailureTime > 0 ? 
                    Date.now() - this.circuitBreaker.lastFailureTime : null
            },
            
            poller: this.poller ? this.poller.getStatus() : null,
            workerPool: this.workerPool ? this.workerPool.getStatus() : null
        };
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = TunnelClient;