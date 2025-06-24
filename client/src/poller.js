const { v4: uuidv4 } = require('uuid');

class Poller {
    constructor(host, options = {}) {
        this.host = host.startsWith('http') ? host : `https://${host}`;
        this.concurrency = Math.min(options.concurrency || 4, 6); // Ограничено 6 соединениями
        this.timeout = options.timeout || 10000; // Уменьшено до 10 секунд
        this.retryDelay = options.retryDelay || 500; // Уменьшено
        this.maxRetryDelay = options.maxRetryDelay || 5000; // Уменьшено
        this.maxRequestSize = options.maxRequestSize || 2 * 1024 * 1024; // 2MB
        this.heartbeatInterval = options.heartbeatInterval || 30000; // 30 секунд
        this.authKey = options.authKey || null;
        this.prefix = options.prefix || '';
        
        this.isRunning = false;
        this.pollingWorkers = [];
        this.activeControllers = new Set();
        this.workerPool = null;
        this.requestHandler = null;
        this.tunnelId = null;
        this.heartbeatTimer = null;
        this.lastHeartbeat = null;
        this.client = null;

        // Enhanced connection tracking
        this.connectionStats = {
            totalPolls: 0,
            successfulPolls: 0,
            emptyPolls: 0,
            timeouts: 0,
            errors: 0,
            lastPollTime: 0,
            avgPollDuration: 0
        };

        // Adaptive polling
        this.adaptivePolling = {
            enabled: true,
            baseInterval: 100, // Очень короткий базовый интервал
            maxInterval: 2000, // Максимум 2 секунды
            currentInterval: 100,
            backoffFactor: 1.2,
            recoveryFactor: 0.8,
            consecutiveEmpty: 0,
            maxConsecutiveEmpty: 5
        };

        // Health monitoring
        this.healthCheck = {
            lastHealthyTime: Date.now(),
            unhealthyThreshold: 60000, // 1 минута без успешных запросов
            maxConsecutiveErrors: 3,
            consecutiveErrors: 0
        };
    }

    setWorkerPool(workerPool) {
        this.workerPool = workerPool;
    }

    setRequestHandler(handler) {
        this.requestHandler = handler;
    }

    setTunnelId(tunnelId) {
        this.tunnelId = tunnelId;
    }

    setClient(client) {
        this.client = client;
    }

    getBaseHeaders() {
        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'flarepipe-client/2.0.3-optimized',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
        };
        
        if (this.authKey) {
            headers['Authorization'] = `Bearer ${this.authKey}`;
        }
        
        return headers;
    }

    buildApiUrl(endpoint) {
        if (this.prefix) {
            return `${this.host}/${this.prefix}/${endpoint}`;
        }
        return `${this.host}/${endpoint}`;
    }

    async start() {
        if (this.isRunning) {
            return;
        }

        if (!this.requestHandler) {
            throw new Error('Request handler must be set before starting');
        }

        this.isRunning = true;
        this.lastHeartbeat = Date.now();
        this.healthCheck.lastHealthyTime = Date.now();
        
        // Start optimized heartbeat
        this.startOptimizedHeartbeat();
        
        // Start multiple polling workers with staggered start
        for (let i = 0; i < this.concurrency; i++) {
            setTimeout(() => {
                if (this.isRunning) {
                    const worker = this.createOptimizedPollingWorker(i);
                    this.pollingWorkers.push(worker);
                }
            }, i * 200); // 200ms между запусками воркеров
        }
    }

    async stop() {
        this.isRunning = false;
        
        // Stop heartbeat
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        
        // Abort all active requests
        for (const controller of this.activeControllers) {
            try {
                controller.abort();
            } catch (error) {
                // Ignore abort errors
            }
        }
        this.activeControllers.clear();
        
        // Wait for all workers to finish with timeout
        const workerPromises = this.pollingWorkers.map(worker => 
            Promise.race([
                worker,
                new Promise(resolve => setTimeout(resolve, 2000)) // 2 секунды максимум
            ])
        );
        
        await Promise.allSettled(workerPromises);
        this.pollingWorkers = [];
    }

    startOptimizedHeartbeat() {
        this.heartbeatTimer = setInterval(async () => {
            try {
                await this.sendOptimizedHeartbeat();
                this.lastHeartbeat = Date.now();
                this.healthCheck.consecutiveErrors = 0;
            } catch (error) {
                this.healthCheck.consecutiveErrors++;
                console.error('Heartbeat failed:', error.message);
                
                if (this.healthCheck.consecutiveErrors >= this.healthCheck.maxConsecutiveErrors) {
                    console.warn('Multiple heartbeat failures, connection may be unstable');
                }
            }
        }, this.heartbeatInterval);
    }

    async sendOptimizedHeartbeat() {
        const controller = new AbortController();
        this.activeControllers.add(controller);
        
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        try {
            const headers = {
                'Content-Type': 'application/json',
                ...this.getBaseHeaders()
            };

            const response = await fetch(this.buildApiUrl('heartbeat'), {
                method: 'POST',
                signal: controller.signal,
                headers: headers,
                body: JSON.stringify({
                    tunnel_id: this.tunnelId,
                    timestamp: Date.now(),
                    stats: this.getPollerStats()
                })
            });

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    throw new Error(`Authentication failed during heartbeat`);
                }
                if (response.status === 404) {
                    throw new Error(`Tunnel not found during heartbeat`);
                }
                throw new Error(`Heartbeat failed: ${response.status}`);
            }
            
            this.healthCheck.lastHealthyTime = Date.now();
            
        } finally {
            clearTimeout(timeoutId);
            this.activeControllers.delete(controller);
        }
    }

    async createOptimizedPollingWorker(workerId) {
        let currentRetryDelay = this.retryDelay;
        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 3;

        console.info(`🔄 Starting optimized polling worker ${workerId}`);

        while (this.isRunning) {
            const pollStartTime = Date.now();
            
            try {
                const hasRequest = await this.pollOnceOptimized();
                
                // Успешный poll
                consecutiveErrors = 0;
                currentRetryDelay = this.retryDelay;
                this.healthCheck.consecutiveErrors = 0;
                this.healthCheck.lastHealthyTime = Date.now();
                
                // Adaptive polling based on activity
                if (hasRequest) {
                    this.adjustPollingInterval(true);
                } else {
                    this.adjustPollingInterval(false);
                    await this.sleep(this.adaptivePolling.currentInterval);
                }
                
            } catch (error) {
                if (!this.isRunning) {
                    break;
                }

                consecutiveErrors++;
                this.healthCheck.consecutiveErrors++;

                if (error.name !== 'AbortError') {
                    console.error(`Poller worker ${workerId} error (${consecutiveErrors}/${maxConsecutiveErrors}):`, error.message);
                }

                // Handle specific errors
                if (error.message.includes('404') || error.message.includes('Tunnel not found')) {
                    console.log('🔄 Tunnel lost, attempting to re-register...');
                    try {
                        await this.handleTunnelLost();
                        consecutiveErrors = 0;
                        continue;
                    } catch (reregisterError) {
                        console.error('Failed to re-register tunnel:', reregisterError.message);
                    }
                }

                // Circuit breaker for polling workers
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    console.warn(`Worker ${workerId} circuit breaker activated, attempting full reconnect...`);
                    try {
                        await this.handleFullReconnect();
                        consecutiveErrors = 0;
                        currentRetryDelay = this.retryDelay;
                        continue;
                    } catch (reconnectError) {
                        console.error('Full reconnect failed:', reconnectError.message);
                        currentRetryDelay = Math.min(currentRetryDelay * 2, this.maxRetryDelay);
                    }
                }
                
                // Adaptive backoff with jitter
                const jitter = Math.random() * 0.3 * currentRetryDelay;
                const delay = currentRetryDelay + jitter;
                await this.sleep(delay);
                
                currentRetryDelay = Math.min(currentRetryDelay * 1.5, this.maxRetryDelay);
            }
        }
        
        console.info(`🛑 Polling worker ${workerId} stopped`);
    }

    async pollOnceOptimized() {
        const controller = new AbortController();
        this.activeControllers.add(controller);
        
        const pollStartTime = Date.now();
        
        try {
            const pollUrl = `${this.buildApiUrl('poll')}${this.tunnelId ? `?tunnel_id=${this.tunnelId}` : ''}`;
            
            const timeoutId = setTimeout(() => controller.abort(), Math.min(this.timeout, 8000));
            
            try {
                const response = await fetch(pollUrl, {
                    method: 'GET',
                    signal: controller.signal,
                    headers: {
                        ...this.getBaseHeaders(),
                        'X-Poll-Worker': 'optimized',
                        'X-Expected-Timeout': String(this.timeout)
                    }
                });

                clearTimeout(timeoutId);
                
                const duration = Date.now() - pollStartTime;
                this.updateConnectionStats(true, duration);

                if (response.status === 404) {
                    throw new Error('Tunnel not found (404) - tunnel may have expired');
                }

                if (response.status === 401 || response.status === 403) {
                    throw new Error('Authentication failed - check auth key');
                }

                if (response.status === 503) {
                    throw new Error('Service temporarily unavailable - server overloaded');
                }

                if (response.status === 204) {
                    this.connectionStats.emptyPolls++;
                    return false;
                }

                if (!response.ok) {
                    throw new Error(`Poll request failed: ${response.status} ${response.statusText}`);
                }

                const requestId = response.headers.get('X-Request-ID');
                const method = response.headers.get('X-Method');
                const path = response.headers.get('X-Path');
                const query = response.headers.get('X-Query');
                const headersJson = response.headers.get('X-Headers');
                const timestamp = response.headers.get('X-Timestamp');
                const shardId = response.headers.get('X-Shard-ID');

                if (!requestId || !method || !path) {
                    throw new Error('Missing required request metadata in headers');
                }

                let requestHeaders = {};
                if (headersJson) {
                    try {
                        requestHeaders = JSON.parse(headersJson);
                    } catch (parseError) {
                        console.warn('Failed to parse request headers:', parseError.message);
                    }
                }

                const body = await response.arrayBuffer();
                
                if (body.byteLength > this.maxRequestSize) {
                    throw new Error(`Request too large: ${body.byteLength} bytes`);
                }

                const requestData = {
                    id: requestId,
                    method: method,
                    path: path,
                    query: query || '',
                    headers: requestHeaders,
                    body: body,
                    timestamp: timestamp ? parseInt(timestamp, 10) : Date.now(),
                    shardId: shardId,
                    receivedAt: Date.now()
                };
                
                if (requestData && requestData.id) {
                    this.processRequestOptimized(requestData);
                    return true;
                }
                
                return false;
                
            } finally {
                clearTimeout(timeoutId);
            }
            
        } catch (error) {
            const duration = Date.now() - pollStartTime;
            this.updateConnectionStats(false, duration);
            
            if (error.name === 'AbortError') {
                this.connectionStats.timeouts++;
            } else {
                this.connectionStats.errors++;
            }
            
            throw error;
        } finally {
            this.activeControllers.delete(controller);
        }
    }

    processRequestOptimized(requestData) {
        const requestPromise = this.processRequestWithOptimizedTimeout(requestData);
        
        if (this.workerPool) {
            this.workerPool.execute(() => requestPromise, { priority: 10 });
        } else {
            setImmediate(() => requestPromise);
        }
    }

    async processRequestWithOptimizedTimeout(requestData) {
        const requestTimeout = 30000;
        
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Request processing timeout')), requestTimeout);
        });

        try {
            await Promise.race([
                this.processRequest(requestData),
                timeoutPromise
            ]);
        } catch (error) {
            console.error(`Request ${requestData.id} failed:`, error.message);
            
            try {
                await this.sendErrorResponse(requestData.id, error);
            } catch (sendError) {
                console.error('Failed to send error response:', sendError.message);
            }
        }
    }

    async processRequest(requestData) {
        try {
            const response = await this.requestHandler(requestData);
            await this.sendOptimizedResponse(requestData.id, response);
        } catch (error) {
            console.error('Error processing request:', error.message);
            await this.sendErrorResponse(requestData.id, error);
        }
    }

    async sendOptimizedResponse(requestId, response) {
        const controller = new AbortController();
        this.activeControllers.add(controller);
        
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        try {
            const responseUrl = this.buildApiUrl('response');
            
            const headers = {
                'X-Request-ID': requestId,
                'X-Tunnel-ID': this.tunnelId,
                'X-Response-Status': String(response.status || 200),
                'X-Response-Headers': JSON.stringify(response.headers || {}),
                'Content-Type': 'application/octet-stream',
                ...this.getBaseHeaders()
            };

            const result = await fetch(responseUrl, {
                method: 'POST',
                signal: controller.signal,
                headers: headers,
                body: response.body || new ArrayBuffer(0)
            });

            if (!result.ok) {
                if (result.status === 401 || result.status === 403) {
                    console.error(`Authentication failed when sending response`);
                } else if (result.status === 404) {
                    console.warn(`Request ${requestId} not found (may have timed out)`);
                } else {
                    console.error(`Failed to send response: ${result.status} ${result.statusText}`);
                }
            }
            
        } finally {
            clearTimeout(timeoutId);
            this.activeControllers.delete(controller);
        }
    }

    async sendErrorResponse(requestId, error) {
        const errorResponse = {
            status: 500,
            headers: { 
                'Content-Type': 'text/plain',
                'X-Error-Type': 'processing-error'
            },
            body: new TextEncoder().encode(`Request processing failed: ${error.message}`).buffer
        };
        
        await this.sendOptimizedResponse(requestId, errorResponse);
    }

    adjustPollingInterval(hasActivity) {
        if (!this.adaptivePolling.enabled) return;
        
        if (hasActivity) {
            this.adaptivePolling.currentInterval = Math.max(
                this.adaptivePolling.currentInterval * this.adaptivePolling.recoveryFactor,
                this.adaptivePolling.baseInterval
            );
            this.adaptivePolling.consecutiveEmpty = 0;
        } else {
            this.adaptivePolling.consecutiveEmpty++;
            
            if (this.adaptivePolling.consecutiveEmpty >= this.adaptivePolling.maxConsecutiveEmpty) {
                this.adaptivePolling.currentInterval = Math.min(
                    this.adaptivePolling.currentInterval * this.adaptivePolling.backoffFactor,
                    this.adaptivePolling.maxInterval
                );
            }
        }
    }

    updateConnectionStats(success, duration) {
        this.connectionStats.totalPolls++;
        this.connectionStats.lastPollTime = Date.now();
        
        if (success) {
            this.connectionStats.successfulPolls++;
        }
        
        const count = this.connectionStats.totalPolls;
        const currentAvg = this.connectionStats.avgPollDuration;
        this.connectionStats.avgPollDuration = (currentAvg * (count - 1) + duration) / count;
    }

    async handleTunnelLost() {
        if (!this.client) {
            throw new Error('No client reference available for re-registration');
        }

        console.log('🔄 Re-registering tunnel after loss...');
        
        await this.client.registerTunnel();
        this.setTunnelId(this.client.tunnelId);
        
        console.log(`✅ Tunnel re-registered with new ID: ${this.client.tunnelId}`);
    }

    async handleFullReconnect() {
        if (!this.client) {
            throw new Error('No client reference available for reconnection');
        }

        console.log('🔄 Performing full reconnect...');
        
        try {
            const oldTunnelId = this.tunnelId;
            
            if (oldTunnelId) {
                try {
                    await this.client.unregisterTunnel();
                } catch (error) {
                    console.warn('Failed to unregister old tunnel:', error.message);
                }
            }
            
            await this.client.registerTunnel();
            this.setTunnelId(this.client.tunnelId);
            
            console.log(`✅ Full reconnect completed with new tunnel: ${this.client.tunnelId}`);
            
        } catch (error) {
            console.error('Full reconnect failed:', error.message);
            throw error;
        }
    }

    getPollerStats() {
        return {
            connection: this.connectionStats,
            adaptive_polling: this.adaptivePolling,
            health: this.healthCheck,
            active_workers: this.pollingWorkers.length,
            active_requests: this.activeControllers.size
        };
    }

    getStatus() {
        const timeSinceLastPoll = this.connectionStats.lastPollTime > 0 ? 
            Date.now() - this.connectionStats.lastPollTime : null;
        
        const isHealthy = this.healthCheck.consecutiveErrors === 0 && 
                         timeSinceLastPoll !== null && timeSinceLastPoll < 30000;

        return {
            isRunning: this.isRunning,
            activeWorkers: this.pollingWorkers.length,
            activeRequests: this.activeControllers.size,
            host: this.host,
            prefix: this.prefix,
            tunnelId: this.tunnelId,
            concurrency: this.concurrency,
            lastHeartbeat: this.lastHeartbeat,
            heartbeatHealthy: this.lastHeartbeat && (Date.now() - this.lastHeartbeat) < this.heartbeatInterval * 2,
            authKeySet: !!this.authKey,
            version: '2.0.3-optimized',
            
            isHealthy: isHealthy,
            timeSinceLastPoll: timeSinceLastPoll,
            
            stats: this.connectionStats,
            adaptivePolling: this.adaptivePolling,
            healthCheck: this.healthCheck,
            
            pollSuccessRate: this.connectionStats.totalPolls > 0 ? 
                ((this.connectionStats.successfulPolls / this.connectionStats.totalPolls) * 100).toFixed(1) + '%' : '0%',
            avgPollDuration: Math.round(this.connectionStats.avgPollDuration),
            currentPollingInterval: this.adaptivePolling.currentInterval
        };
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = Poller;