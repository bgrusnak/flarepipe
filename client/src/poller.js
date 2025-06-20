// src/poller.js

const { v4: uuidv4 } = require('uuid');

class Poller {
  /**
   * Creates a new poller instance
   * @param {string} host - CF Worker host URL
   * @param {object} options - Configuration options
   */
  constructor(host, options = {}) {
    this.host = host.startsWith('http') ? host : `https://${host}`;
    this.concurrency = options.concurrency || 16;
    this.timeout = options.timeout || 30000; // 30 seconds
    this.retryDelay = options.retryDelay || 1000; // 1 second
    this.maxRetryDelay = options.maxRetryDelay || 30000; // 30 seconds
    this.maxRequestSize = options.maxRequestSize || 10 * 1024 * 1024; // 10MB
    this.heartbeatInterval = options.heartbeatInterval || 60000; // 1 minute
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
  }

  /**
   * Sets the worker pool for processing requests
   * @param {WorkerPool} workerPool - Worker pool instance
   */
  setWorkerPool(workerPool) {
    this.workerPool = workerPool;
  }

  /**
   * Sets the request handler function
   * @param {Function} handler - Async function to handle requests
   */
  setRequestHandler(handler) {
    this.requestHandler = handler;
  }

  /**
   * Sets the tunnel ID for this client
   * @param {string} tunnelId - Unique tunnel identifier
   */
  setTunnelId(tunnelId) {
    this.tunnelId = tunnelId;
  }

  /**
   * Gets base headers for server requests
   * @returns {object} - Headers object
   */
  getBaseHeaders() {
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'flarepipe-client/1.0.0'
    };
    
    if (this.authKey) {
      headers['Authorization'] = `Bearer ${this.authKey}`;
    }
    
    return headers;
  }

  /**
   * Builds API URL with prefix
   * @param {string} endpoint - API endpoint (e.g., 'register', 'poll')
   * @returns {string} - Full API URL
   */
  buildApiUrl(endpoint) {
    if (this.prefix) {
      return `${this.host}/${this.prefix}/${endpoint}`;
    }
    return `${this.host}/${endpoint}`;
  }

  /**
   * Starts polling with multiple concurrent workers
   */
  async start() {
    if (this.isRunning) {
      return;
    }

    if (!this.requestHandler) {
      throw new Error('Request handler must be set before starting');
    }

    this.isRunning = true;
    this.lastHeartbeat = Date.now();
    
    // Start heartbeat monitoring
    this.startHeartbeat();
    
    // Start multiple polling workers
    for (let i = 0; i < this.concurrency; i++) {
      const worker = this.createPollingWorker(i);
      this.pollingWorkers.push(worker);
    }
  }

  /**
   * Stops all polling workers
   */
  async stop() {
    this.isRunning = false;
    
    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    // Abort all active requests
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
    
    // Wait for all workers to finish
    await Promise.allSettled(this.pollingWorkers);
    this.pollingWorkers = [];
  }

  /**
   * Starts heartbeat monitoring
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.sendHeartbeat();
        this.lastHeartbeat = Date.now();
      } catch (error) {
        console.error('Heartbeat failed:', error.message);
        // If heartbeat fails multiple times, consider reconnecting
        const timeSinceLastSuccess = Date.now() - this.lastHeartbeat;
        if (timeSinceLastSuccess > this.heartbeatInterval * 3) {
          console.warn('Multiple heartbeat failures, connection may be lost');
        }
      }
    }, this.heartbeatInterval);
  }

  /**
   * Sends heartbeat to server
   */
  async sendHeartbeat() {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    
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
          timestamp: Date.now()
        })
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Authentication failed during heartbeat`);
        }
        throw new Error(`Heartbeat failed: ${response.status}`);
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  /**
   * Creates a single polling worker
   * @param {number} workerId - Worker identifier
   * @returns {Promise} - Worker promise
   */
  async createPollingWorker(workerId) {
    let currentRetryDelay = this.retryDelay;

    while (this.isRunning) {
      try {
        await this.pollOnce();
        // Reset retry delay on successful poll
        currentRetryDelay = this.retryDelay;
      } catch (error) {
        if (!this.isRunning) {
          break;
        }

        // Don't log abort errors
        if (error.name !== 'AbortError') {
          console.error(`Poller worker ${workerId} error:`, error.message);
        }
        
        // Exponential backoff with jitter
        const jitter = Math.random() * 0.1 * currentRetryDelay;
        await this.sleep(currentRetryDelay + jitter);
        currentRetryDelay = Math.min(currentRetryDelay * 2, this.maxRetryDelay);
      }
    }
  }

  /**
   * Performs a single poll request
   */
  async pollOnce() {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    
    try {
      const pollUrl = `${this.buildApiUrl('poll')}${this.tunnelId ? `?tunnel_id=${this.tunnelId}` : ''}`;
      
      const response = await fetch(pollUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: this.getBaseHeaders()
      });

      if (response.status === 204) {
        // No requests available, continue polling
        return;
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Authentication failed during polling`);
        }
        throw new Error(`Poll request failed: ${response.status} ${response.statusText}`);
      }

      // Check content size
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > this.maxRequestSize) {
        throw new Error(`Request too large: ${contentLength} bytes`);
      }

      // Check content type before parsing JSON
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error(`Invalid content type: ${contentType}`);
      }

      const requestData = await response.json();
      
      if (requestData && requestData.id) {
        // Process request through worker pool with timeout
        const requestPromise = this.processRequestWithTimeout(requestData);
        
        if (this.workerPool) {
          this.workerPool.execute(() => requestPromise);
        } else {
          // Fallback: process directly
          setImmediate(() => requestPromise);
        }
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  /**
   * Processes request with timeout to prevent memory leaks
   * @param {object} requestData - Request data from server
   */
  async processRequestWithTimeout(requestData) {
    const requestTimeout = 5 * 60 * 1000; // 5 minutes max per request
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), requestTimeout);
    });

    try {
      await Promise.race([
        this.processRequest(requestData),
        timeoutPromise
      ]);
    } catch (error) {
      console.error(`Request ${requestData.id} failed:`, error.message);
    }
  }

  /**
   * Processes a single HTTP request
   * @param {object} requestData - Request data from server
   */
  async processRequest(requestData) {
    try {
      const response = await this.requestHandler(requestData);
      await this.sendResponse(requestData.id, response);
    } catch (error) {
      console.error('Error processing request:', error.message);
      
      // Send error response
      await this.sendResponse(requestData.id, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
        body: 'Internal tunnel error'
      });
    }
  }

  /**
   * Sends response back to the server
   * @param {string} requestId - Request identifier
   * @param {object} response - Response data
   */
  async sendResponse(requestId, response) {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    
    try {
      const responseUrl = this.buildApiUrl('response');
      
      const headers = {
        'Content-Type': 'application/json',
        ...this.getBaseHeaders()
      };
      
      const result = await fetch(responseUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: headers,
        body: JSON.stringify({
          request_id: requestId,
          tunnel_id: this.tunnelId,
          status: response.status || 200,
          headers: response.headers || {},
          body: response.body || ''
        })
      });

      if (!result.ok) {
        if (result.status === 401 || result.status === 403) {
          console.error(`Authentication failed when sending response`);
        } else {
          console.error(`Failed to send response: ${result.status} ${result.statusText}`);
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Error sending response:', error.message);
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  /**
   * Sleep utility function
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Gets current poller status
   * @returns {object} - Status information
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activeWorkers: this.pollingWorkers.length,
      activeRequests: this.activeControllers.size,
      host: this.host,
      prefix: this.prefix,
      tunnelId: this.tunnelId,
      concurrency: this.concurrency,
      lastHeartbeat: this.lastHeartbeat,
      heartbeatHealthy: this.lastHeartbeat && (Date.now() - this.lastHeartbeat) < this.heartbeatInterval * 2
    };
  }
}

module.exports = Poller;