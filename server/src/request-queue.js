// src/request-queue.js

export default class RequestQueue {
    /**
     * Creates a new request queue manager
     * @param {Map} requestQueues - Global request queues storage (tunnel_id -> request[])
     * @param {Map} pendingResponses - Global pending responses storage (request_id -> promise resolver)
     */
    constructor(requestQueues, pendingResponses) {
      this.requestQueues = requestQueues;
      this.pendingResponses = pendingResponses;
      this.maxQueueSize = 100; // Maximum requests per tunnel
      this.requestTimeout = 30000; // 30 seconds
      this.pollTimeout = 30000; // 30 seconds for long polling
      this.pollInterval = 500; // 500ms polling interval (CF Worker friendly)
      this.maxRecursiveDepth = 10; // Prevent excessive recursion
      this.lastCleanup = Date.now();
      this.cleanupInterval = 60000; // 1 minute
    }
  
    /**
     * Queues a public request and waits for response from tunnel client
     * @param {string} tunnelId - Tunnel ID to queue request for
     * @param {object} requestData - Serialized request data
     * @param {number} timeout - Request timeout in milliseconds
     * @returns {Promise<object>} - Promise that resolves with response
     */
    async queueRequest(tunnelId, requestData, timeout = this.requestTimeout) {
      if (!tunnelId || !requestData) {
        throw new Error('Missing tunnelId or requestData');
      }
  
      // Get or create queue for tunnel
      let queue = this.requestQueues.get(tunnelId);
      if (!queue) {
        queue = [];
        this.requestQueues.set(tunnelId, queue);
      }
  
      // Check queue size limit
      if (queue.length >= this.maxQueueSize) {
        throw new Error('Tunnel queue is full');
      }
  
      // Add timeout to request data
      requestData.timeout_at = Date.now() + timeout;
  
      // Add request to queue
      queue.push(requestData);
  
      // Create promise for response
      return new Promise((resolve, reject) => {
        // Store resolver for when response comes back
        this.pendingResponses.set(requestData.id, {
          resolve,
          reject,
          tunnel_id: tunnelId,
          created_at: Date.now(),
          timeout_at: Date.now() + timeout
        });
  
        // Set timeout
        setTimeout(() => {
          const pending = this.pendingResponses.get(requestData.id);
          if (pending) {
            this.pendingResponses.delete(requestData.id);
            reject(new Error('Request timeout'));
          }
        }, timeout);
  
        // Opportunistic cleanup
        this.maybeCleanup();
      });
    }
  
    /**
     * Long-polling endpoint for tunnel clients to get next request
     * @param {string} tunnelId - Tunnel ID to poll for
     * @param {number} timeout - Polling timeout in milliseconds
     * @returns {Promise<object|null>} - Promise that resolves with request or null if timeout
     */
    async waitForRequest(tunnelId, timeout = this.pollTimeout) {
      if (!tunnelId) {
        throw new Error('Missing tunnelId');
      }
  
      // Get queue for tunnel
      const queue = this.requestQueues.get(tunnelId);
      
      // If queue has requests, return immediately
      if (queue && queue.length > 0) {
        const request = queue.shift();
        
        // Check if request is still valid (not expired)
        if (request.timeout_at && Date.now() > request.timeout_at) {
          // Request expired, reject it and try next
          this.rejectExpiredRequest(request.id);
          return this.waitForRequest(tunnelId, timeout); // Recursive call
        }
        
        return request;
      }
  
      // No requests available, set up long polling
      return new Promise((resolve) => {
        const startTime = Date.now();
        
        const checkForRequests = () => {
          const queue = this.requestQueues.get(tunnelId);
          
          // Check if new requests arrived
          if (queue && queue.length > 0) {
            const request = queue.shift();
            
            // Check if request is still valid
            if (request.timeout_at && Date.now() > request.timeout_at) {
              this.rejectExpiredRequest(request.id);
              // Continue checking
              if (Date.now() - startTime < timeout) {
                setTimeout(checkForRequests, 100);
              } else {
                resolve(null); // Timeout
              }
              return;
            }
            
            resolve(request);
            return;
          }
  
          // Check timeout
          if (Date.now() - startTime >= timeout) {
            resolve(null); // No request available within timeout
            return;
          }
  
          // Continue polling
          setTimeout(checkForRequests, 100); // Check every 100ms
        };
  
        // Start polling
        checkForRequests();
      });
    }
  
    /**
     * Resolves a pending request with response from tunnel client
     * @param {string} requestId - Request ID to resolve
     * @param {object} responseData - Response data from client
     */
    async resolveRequest(requestId, responseData) {
      if (!requestId) {
        throw new Error('Missing requestId');
      }
  
      const pending = this.pendingResponses.get(requestId);
      if (!pending) {
        throw new Error('Request not found or already resolved');
      }
  
      // Remove from pending
      this.pendingResponses.delete(requestId);
  
      // Resolve the promise
      pending.resolve(responseData);
    }
  
    /**
     * Rejects an expired request
     * @param {string} requestId - Request ID to reject
     */
    rejectExpiredRequest(requestId) {
      const pending = this.pendingResponses.get(requestId);
      if (pending) {
        this.pendingResponses.delete(requestId);
        pending.reject(new Error('Request timeout'));
      }
    }
  
    /**
     * Opportunistic cleanup to avoid setInterval
     */
    maybeCleanup() {
      const now = Date.now();
      
      if (now - this.lastCleanup > this.cleanupInterval) {
        this.lastCleanup = now;
        this.cleanupExpiredRequests();
      }
    }
  
    /**
     * Cleans up expired requests and empty queues
     */
    cleanupExpiredRequests() {
      const now = Date.now();
      let cleanedRequests = 0;
      let cleanedQueues = 0;
  
      // Clean up expired pending responses
      const expiredResponses = [];
      for (const [requestId, pending] of this.pendingResponses) {
        if (now > pending.timeout_at) {
          expiredResponses.push(requestId);
        }
      }
  
      for (const requestId of expiredResponses) {
        this.rejectExpiredRequest(requestId);
        cleanedRequests++;
      }
  
      // Clean up expired requests in queues and empty queues
      const emptyQueues = [];
      for (const [tunnelId, queue] of this.requestQueues) {
        // Filter out expired requests
        const originalLength = queue.length;
        const validRequests = queue.filter(request => {
          if (request.timeout_at && now > request.timeout_at) {
            // Also reject any pending response for this expired request
            this.rejectExpiredRequest(request.id);
            return false;
          }
          return true;
        });
  
        // Update queue with valid requests
        this.requestQueues.set(tunnelId, validRequests);
        cleanedRequests += (originalLength - validRequests.length);
  
        // Mark empty queues for removal
        if (validRequests.length === 0) {
          emptyQueues.push(tunnelId);
        }
      }
  
      // Remove empty queues
      for (const tunnelId of emptyQueues) {
        this.requestQueues.delete(tunnelId);
        cleanedQueues++;
      }
  
      if (cleanedRequests > 0 || cleanedQueues > 0) {
        console.log(`Request queue cleanup: removed ${cleanedRequests} expired requests, ${cleanedQueues} empty queues`);
      }
    }
  
    /**
     * Cancels all pending requests for a tunnel (when tunnel disconnects)
     * @param {string} tunnelId - Tunnel ID to cancel requests for
     */
    cancelTunnelRequests(tunnelId) {
      // Remove queue
      const queue = this.requestQueues.get(tunnelId);
      if (queue) {
        // Reject all queued requests
        for (const request of queue) {
          this.rejectExpiredRequest(request.id);
        }
        this.requestQueues.delete(tunnelId);
      }
  
      // Find and reject all pending responses for this tunnel
      const toCancel = [];
      for (const [requestId, pending] of this.pendingResponses) {
        if (pending.tunnel_id === tunnelId) {
          toCancel.push(requestId);
        }
      }
  
      for (const requestId of toCancel) {
        const pending = this.pendingResponses.get(requestId);
        if (pending) {
          this.pendingResponses.delete(requestId);
          pending.reject(new Error('Tunnel disconnected'));
        }
      }
  
      console.log(`Cancelled ${toCancel.length} requests for tunnel ${tunnelId}`);
    }
  
    /**
     * Gets statistics about request queues
     * @returns {object} - Queue statistics
     */
    getStats() {
      let totalQueued = 0;
      let totalPending = this.pendingResponses.size;
      let activeQueues = 0;
  
      for (const [tunnelId, queue] of this.requestQueues) {
        if (queue.length > 0) {
          activeQueues++;
          totalQueued += queue.length;
        }
      }
  
      return {
        total_queued: totalQueued,
        total_pending: totalPending,
        active_queues: activeQueues,
        total_queues: this.requestQueues.size,
        max_queue_size: this.maxQueueSize,
        request_timeout: this.requestTimeout,
        poll_timeout: this.pollTimeout
      };
    }
  
    /**
     * Lists queue status for debugging
     * @returns {Array} - Array of queue status
     */
    listQueues() {
      const queues = [];
  
      for (const [tunnelId, queue] of this.requestQueues) {
        queues.push({
          tunnel_id: tunnelId,
          queued_requests: queue.length,
          oldest_request: queue.length > 0 ? queue[0].timestamp : null
        });
      }
  
      return queues;
    }
  
    /**
     * Emergency cleanup - cancels all requests (for shutdown)
     */
    shutdown() {
      // Cancel all pending responses
      for (const [requestId, pending] of this.pendingResponses) {
        pending.reject(new Error('Server shutdown'));
      }
      this.pendingResponses.clear();
  
      // Clear all queues
      this.requestQueues.clear();
  
      console.log('Request queue shutdown completed');
    }
  }