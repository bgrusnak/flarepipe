class WorkerPool {
    /**
     * Creates a new worker pool
     * @param {number} maxConcurrency - Maximum number of concurrent workers
     * @param {object} options - Additional options
     */
    constructor(maxConcurrency = 16, options = {}) {
      this.maxWorkers = maxConcurrency;
      this.activeWorkers = 0;
      this.priorityQueues = new Map(); // Priority -> tasks array
      this.totalQueuedTasks = 0; // Cache for performance
      this.maxQueueSize = options.maxQueueSize || 1000;
      this.taskTimeout = options.taskTimeout || 5 * 60 * 1000; // 5 minutes
      this.enableBackpressure = options.enableBackpressure !== false;
      this.backpressureThreshold = options.backpressureThreshold || 0.8;
      
      // Graceful degradation
      this.errorWindow = options.errorWindow || 60000; // 1 minute
      this.maxErrorsPerWindow = options.maxErrorsPerWindow || 10;
      this.degradationFactor = options.degradationFactor || 0.5;
      this.isDegraded = false;
      this.errorTimestamps = [];
      this.errorCleanupTimer = null;
      this.lastDegradationCheck = 0;
      this.degradationCooldown = options.degradationCooldown || 5000; // 5 seconds
      
      // Statistics
      this.stats = {
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        queuedTasks: 0,
        timeouts: 0
      };
      
      // Internal state
      this.processingMutex = false;
      this.pendingProcess = false;
      this.schedulingLock = false;
      this.isShuttingDown = false;
      this.shutdownPromise = null;
      
      this.startErrorCleanup();
    }
  
    /**
     * Starts periodic cleanup of old error timestamps
     */
    startErrorCleanup() {
      this.errorCleanupTimer = setInterval(() => {
        this.cleanupOldErrors();
      }, Math.min(this.errorWindow / 4, 15000)); // Clean more frequently
    }
  
    /**
     * Cleans up old error timestamps with degradation stability
     */
    cleanupOldErrors() {
      const now = Date.now();
      const oldLength = this.errorTimestamps.length;
      this.errorTimestamps = this.errorTimestamps.filter(
        timestamp => now - timestamp < this.errorWindow
      );
      
      // Only check for recovery if enough time has passed to avoid flapping
      if (this.isDegraded && now - this.lastDegradationCheck > this.degradationCooldown) {
        if (this.errorTimestamps.length < this.maxErrorsPerWindow * 0.3) { // 30% threshold for recovery
          this.isDegraded = false;
          this.lastDegradationCheck = now;
          console.info('Worker pool recovered from degradation');
        }
      }
    }
  
    /**
     * Executes a task with concurrency control and priority support
     * @param {Function} task - Async function to execute
     * @param {object} options - Task options (priority, timeout)
     * @returns {Promise} - Promise that resolves with task result
     */
    async execute(task, options = {}) {
      // Fast fail if shutting down
      if (this.isShuttingDown) {
        throw new Error('Worker pool is shutting down');
      }
      
      const priority = options.priority || 0;
      const timeout = options.timeout || this.taskTimeout;
      
      // Use cached total for performance
      if (this.totalQueuedTasks >= this.maxQueueSize) {
        this.stats.failedTasks++;
        throw new Error('Worker pool queue is full');
      }
      
      // Check backpressure after queue size check
      if (this.enableBackpressure && this.isOverloaded()) {
        this.stats.failedTasks++;
        throw new Error('Worker pool overloaded - backpressure applied');
      }
  
      return new Promise((resolve, reject) => {
        // Double-check shutdown state inside Promise constructor
        if (this.isShuttingDown) {
          reject(new Error('Worker pool is shutting down'));
          return;
        }
  
        const wrappedTask = {
          task,
          resolve,
          reject,
          priority,
          timeout,
          createdAt: Date.now(),
          id: this.generateTaskId()
        };
  
        this.stats.totalTasks++;
        this.stats.queuedTasks++;
        
        // Add task to priority queue
        this.addTaskToPriorityQueue(wrappedTask);
        
        // Schedule queue processing with race condition protection
        this.scheduleQueueProcessingSafe();
      });
    }
  
    /**
     * Adds task to appropriate priority queue
     * @param {object} wrappedTask - Task to add
     */
    addTaskToPriorityQueue(wrappedTask) {
      const priority = wrappedTask.priority;
      if (!this.priorityQueues.has(priority)) {
        this.priorityQueues.set(priority, []);
      }
      this.priorityQueues.get(priority).push(wrappedTask);
      this.totalQueuedTasks++;
    }
  
    /**
     * Gets next task from highest priority queue with cleanup
     * @returns {object|null} - Next task or null if no tasks
     */
    getNextTask() {
      if (this.totalQueuedTasks === 0) {
        return null;
      }
  
      const priorities = Array.from(this.priorityQueues.keys()).sort((a, b) => b - a);
      
      for (const priority of priorities) {
        const queue = this.priorityQueues.get(priority);
        if (queue && queue.length > 0) {
          const task = queue.shift();
          this.stats.queuedTasks--;
          this.totalQueuedTasks--;
          
          // Clean up empty priority queues to prevent memory leak
          if (queue.length === 0) {
            this.priorityQueues.delete(priority);
          }
          
          return task;
        }
      }
      
      // Sync cache if inconsistent
      this.syncQueueCache();
      return null;
    }
  
    /**
     * Syncs the cached queue count with actual queues
     */
    syncQueueCache() {
      let actualTotal = 0;
      for (const queue of this.priorityQueues.values()) {
        actualTotal += queue.length;
      }
      
      if (this.totalQueuedTasks !== actualTotal) {
        console.warn(`Queue cache inconsistency detected: cached=${this.totalQueuedTasks}, actual=${actualTotal}`);
        this.totalQueuedTasks = actualTotal;
      }
    }
  
    /**
     * Race-condition safe scheduling with atomic lock
     */
    scheduleQueueProcessingSafe() {
      // Atomic check and set
      if (this.schedulingLock) {
        this.pendingProcess = true;
        return;
      }
      
      this.schedulingLock = true;
      
      setImmediate(() => {
        this.schedulingLock = false;
        this.processQueueSafely();
      });
    }
  
    /**
     * Thread-safe queue processing wrapper
     */
    async processQueueSafely() {
      // Check if already processing
      if (this.processingMutex) {
        this.pendingProcess = true;
        return;
      }
      
      this.processingMutex = true;
      const hadPendingBefore = this.pendingProcess;
      this.pendingProcess = false;
      
      try {
        await this.processQueue();
      } finally {
        this.processingMutex = false;
        
        // Process again if there was a pending request or new one arrived
        if ((this.pendingProcess || hadPendingBefore) && !this.isShuttingDown) {
          setImmediate(() => this.processQueueSafely());
        }
      }
    }
  
    /**
     * Processes queued tasks if workers are available
     */
    async processQueue() {
      const effectiveMaxWorkers = this.getEffectiveMaxWorkers();
      
      while (this.activeWorkers < effectiveMaxWorkers && this.totalQueuedTasks > 0 && !this.isShuttingDown) {
        const nextTask = this.getNextTask();
        if (!nextTask) {
          break;
        }
        
        // Start task without waiting for it
        this.runTask(nextTask);
      }
    }
  
    /**
     * Gets effective max workers considering degradation
     * @returns {number} - Effective worker limit
     */
    getEffectiveMaxWorkers() {
      if (this.isShuttingDown) {
        return 0;
      }
      
      if (this.isDegraded) {
        return Math.max(1, Math.floor(this.maxWorkers * this.degradationFactor));
      }
      return this.maxWorkers;
    }
  
    /**
     * Runs a task with timeout and error handling
     * @param {object} wrappedTask - Task wrapper with resolve/reject
     */
    async runTask(wrappedTask) {
      // Final shutdown check before starting work
      if (this.isShuttingDown) {
        wrappedTask.reject(new Error('Worker pool is shutting down'));
        return;
      }
  
      this.activeWorkers++;
  
      let timeoutId = null;
      let completed = false;
      
      const complete = (success, result) => {
        if (completed) return false;
        completed = true;
        
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        
        if (success) {
          this.stats.completedTasks++;
          wrappedTask.resolve(result);
        } else {
          this.stats.failedTasks++;
          wrappedTask.reject(result);
        }
        
        return true;
      };
  
      try {
        // Set up timeout
        timeoutId = setTimeout(() => {
          if (complete(false, new Error(`Task timeout after ${wrappedTask.timeout}ms`))) {
            this.stats.timeouts++;
          }
        }, wrappedTask.timeout);
  
        // Execute task
        const result = await wrappedTask.task();
        complete(true, result);
        
      } catch (error) {
        if (complete(false, error)) {
          this.recordError();
        }
      } finally {
        this.activeWorkers--;
        
        // Schedule next processing only if not shutting down
        if (!this.isShuttingDown && this.totalQueuedTasks > 0) {
          this.scheduleQueueProcessingSafe();
        }
      }
    }
  
    /**
     * Records error for graceful degradation with stability
     */
    recordError() {
      const now = Date.now();
      this.errorTimestamps.push(now);
      
      // Only check for degradation if cooldown period has passed
      if (!this.isDegraded && now - this.lastDegradationCheck > this.degradationCooldown) {
        if (this.errorTimestamps.length >= this.maxErrorsPerWindow) {
          this.isDegraded = true;
          this.lastDegradationCheck = now;
          console.warn(`Worker pool degraded due to ${this.errorTimestamps.length} errors in ${this.errorWindow}ms`);
        }
      }
    }
  
    /**
     * Checks if pool is overloaded for backpressure
     * @returns {boolean} - True if overloaded
     */
    isOverloaded() {
      const effectiveMaxWorkers = this.getEffectiveMaxWorkers();
      if (effectiveMaxWorkers === 0) return true;
      
      const utilization = this.activeWorkers / effectiveMaxWorkers;
      const queueUtilization = this.totalQueuedTasks / this.maxQueueSize;
      
      return utilization >= this.backpressureThreshold || 
             queueUtilization >= this.backpressureThreshold;
    }
  
    /**
     * Generates unique task ID
     * @returns {string} - Unique task identifier
     */
    generateTaskId() {
      return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
  
    /**
     * Gets current pool status with thread-safe reads
     * @returns {object} - Pool statistics
     */
    getStatus() {
      const effectiveMaxWorkers = this.getEffectiveMaxWorkers();
      
      return {
        activeWorkers: this.activeWorkers,
        queuedTasks: this.totalQueuedTasks,
        maxWorkers: this.maxWorkers,
        effectiveMaxWorkers,
        utilization: effectiveMaxWorkers > 0 ? (this.activeWorkers / effectiveMaxWorkers * 100).toFixed(1) + '%' : '0%',
        queueUtilization: (this.totalQueuedTasks / this.maxQueueSize * 100).toFixed(1) + '%',
        isDegraded: this.isDegraded,
        isOverloaded: this.isOverloaded(),
        isShuttingDown: this.isShuttingDown,
        stats: { ...this.stats },
        recentErrors: this.errorTimestamps.length,
        priorityQueues: this.priorityQueues.size
      };
    }
  
    /**
     * Checks if pool is at capacity
     * @returns {boolean} - True if all workers are busy
     */
    isAtCapacity() {
      return this.activeWorkers >= this.getEffectiveMaxWorkers();
    }
  
    /**
     * Gets number of pending tasks (uses cached value)
     * @returns {number} - Number of queued tasks
     */
    getPendingCount() {
      return this.totalQueuedTasks;
    }
  
    /**
     * Clears all queued tasks (does not affect running tasks)
     * @param {string} reason - Reason for clearing queue
     */
    clearQueue(reason = 'Queue cleared') {
      let clearedCount = 0;
      
      for (const [priority, queue] of this.priorityQueues) {
        while (queue.length > 0) {
          const task = queue.shift();
          clearedCount++;
          this.stats.queuedTasks--;
          this.stats.failedTasks++;
          task.reject(new Error(`Task cancelled - ${reason}`));
        }
      }
      
      this.priorityQueues.clear();
      this.totalQueuedTasks = 0;
      
      if (clearedCount > 0) {
        console.info(`Cleared ${clearedCount} queued tasks: ${reason}`);
      }
    }
  
    /**
     * Updates maximum worker count with validation
     * @param {number} newMax - New maximum worker count
     */
    setMaxWorkers(newMax) {
      if (newMax < 1) {
        throw new Error('Max workers must be at least 1');
      }
      
      const oldMax = this.maxWorkers;
      this.maxWorkers = newMax;
      
      console.info(`Worker pool max workers changed from ${oldMax} to ${newMax}`);
      
      // Schedule processing if we increased capacity
      if (newMax > oldMax && !this.isShuttingDown && this.totalQueuedTasks > 0) {
        this.scheduleQueueProcessingSafe();
      }
    }
  
    /**
     * Waits for all active tasks to complete
     * @param {number} timeout - Max time to wait in ms
     * @returns {Promise<boolean>} - True if all tasks completed
     */
    async waitForIdle(timeout = 30000) {
      const startTime = Date.now();
      
      while ((this.activeWorkers > 0 || this.totalQueuedTasks > 0) && !this.isShuttingDown) {
        if (Date.now() - startTime > timeout) {
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      return true;
    }
  
    /**
     * Graceful shutdown of the worker pool
     * @param {number} timeout - Max time to wait for completion
     */
    async shutdown(timeout = 30000) {
      if (this.shutdownPromise) {
        return this.shutdownPromise;
      }
      
      this.shutdownPromise = this._performShutdown(timeout);
      return this.shutdownPromise;
    }
  
    /**
     * Internal shutdown implementation
     * @param {number} timeout - Max time to wait for completion
     */
    async _performShutdown(timeout) {
      console.info('Shutting down worker pool...');
      this.isShuttingDown = true;
      
      // Stop error cleanup timer
      if (this.errorCleanupTimer) {
        clearInterval(this.errorCleanupTimer);
        this.errorCleanupTimer = null;
      }
      
      // Clear queue immediately
      this.clearQueue('Worker pool shutdown');
      
      // Wait for active tasks with proper timeout
      const completed = await this.waitForIdle(timeout);
      
      if (!completed) {
        console.warn(`Worker pool shutdown timeout - ${this.activeWorkers} tasks still running`);
      } else {
        console.info('Worker pool shutdown completed');
      }
      
      return completed;
    }
  }
  
  module.exports = WorkerPool;