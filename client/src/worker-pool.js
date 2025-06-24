// client/src/worker-pool-optimized.js - Оптимизированная версия с агрессивными лимитами

class WorkerPool {
  constructor(maxConcurrency = 8, options = {}) {
      this.maxWorkers = Math.min(maxConcurrency, 12); // Жесткий лимит в 12 воркеров
      this.activeWorkers = 0;
      this.priorityQueues = new Map();
      this.totalQueuedTasks = 0;
      
      // Агрессивно уменьшенные лимиты
      this.maxQueueSize = options.maxQueueSize || Math.max(this.maxWorkers * 2, 8);
      this.taskTimeout = options.taskTimeout || 30000; // 30 секунд
      this.enableBackpressure = options.enableBackpressure !== false;
      this.backpressureThreshold = options.backpressureThreshold || 0.6; // Более агрессивный
      
      // Агрессивная деградация
      this.errorWindow = options.errorWindow || 30000; // 30 секунд
      this.maxErrorsPerWindow = options.maxErrorsPerWindow || 3; // Всего 3 ошибки
      this.degradationFactor = options.degradationFactor || 0.3; // Сильная деградация
      this.isDegraded = false;
      this.errorTimestamps = [];
      this.errorCleanupTimer = null;
      this.lastDegradationCheck = 0;
      this.degradationCooldown = options.degradationCooldown || 3000; // 3 секунды
      
      // Enhanced performance tracking
      this.performanceMetrics = {
          totalTasks: 0,
          completedTasks: 0,
          failedTasks: 0,
          queuedTasks: 0,
          timeouts: 0,
          degradationEvents: 0,
          avgExecutionTime: 0,
          peakConcurrency: 0,
          lastExecutionTime: 0
      };
      
      // Circuit breaker for task execution
      this.circuitBreaker = {
          isOpen: false,
          failureCount: 0,
          failureThreshold: 5,
          resetTimeout: 15000, // 15 секунд
          lastFailureTime: 0,
          successCount: 0,
          successThreshold: 3
      };
      
      // Internal state with enhanced protection
      this.processingMutex = false;
      this.pendingProcess = false;
      this.schedulingLock = false;
      this.isShuttingDown = false;
      this.shutdownPromise = null;
      this.emergencyMode = false;
      
      // Task execution tracking
      this.executingTasks = new Map(); // taskId -> { startTime, timeout }
      
      this.startErrorCleanup();
  }

  startErrorCleanup() {
      this.errorCleanupTimer = setInterval(() => {
          this.cleanupOldErrors();
          this.checkCircuitBreaker();
          this.monitorTaskExecution();
      }, Math.min(this.errorWindow / 3, 10000)); // Более частая очистка
  }

  cleanupOldErrors() {
      const now = Date.now();
      const oldLength = this.errorTimestamps.length;
      this.errorTimestamps = this.errorTimestamps.filter(
          timestamp => now - timestamp < this.errorWindow
      );
      
      // Более агрессивная проверка восстановления
      if (this.isDegraded && now - this.lastDegradationCheck > this.degradationCooldown) {
          if (this.errorTimestamps.length === 0) { // Полное отсутствие ошибок для восстановления
              this.isDegraded = false;
              this.lastDegradationCheck = now;
              console.info('Worker pool recovered from degradation');
          }
      }
  }

  checkCircuitBreaker() {
      const now = Date.now();
      
      if (this.circuitBreaker.isOpen) {
          // Check if reset timeout has passed
          if (now - this.circuitBreaker.lastFailureTime > this.circuitBreaker.resetTimeout) {
              this.circuitBreaker.isOpen = false;
              this.circuitBreaker.failureCount = 0;
              this.circuitBreaker.successCount = 0;
              console.info('Worker pool circuit breaker reset');
          }
      }
  }

  monitorTaskExecution() {
      const now = Date.now();
      const staleTasks = [];
      
      // Check for stale executing tasks
      for (const [taskId, taskInfo] of this.executingTasks) {
          if (now - taskInfo.startTime > taskInfo.timeout * 1.5) {
              staleTasks.push(taskId);
          }
      }
      
      // Clean up stale tasks
      for (const taskId of staleTasks) {
          this.executingTasks.delete(taskId);
          console.warn(`Cleaned up stale task: ${taskId}`);
      }
  }

  async execute(task, options = {}) {
      // Fast fail if shutting down
      if (this.isShuttingDown) {
          throw new Error('Worker pool is shutting down');
      }
      
      // Emergency mode check
      if (this.emergencyMode) {
          throw new Error('Worker pool in emergency mode');
      }
      
      // Circuit breaker check
      if (this.circuitBreaker.isOpen) {
          this.performanceMetrics.failedTasks++;
          throw new Error('Worker pool circuit breaker is open');
      }
      
      const priority = options.priority || 0;
      const timeout = Math.min(options.timeout || this.taskTimeout, 45000); // Максимум 45 секунд
      
      // Aggressive queue size check
      if (this.totalQueuedTasks >= this.maxQueueSize) {
          this.performanceMetrics.failedTasks++;
          throw new Error('Worker pool queue is full');
      }
      
      // Enhanced backpressure check
      if (this.enableBackpressure && this.isOverloaded()) {
          this.performanceMetrics.failedTasks++;
          throw new Error('Worker pool overloaded - backpressure applied');
      }

      return new Promise((resolve, reject) => {
          if (this.isShuttingDown) {
              reject(new Error('Worker pool is shutting down'));
              return;
          }

          const taskId = this.generateTaskId();
          const wrappedTask = {
              task,
              resolve,
              reject,
              priority,
              timeout,
              createdAt: Date.now(),
              id: taskId
          };

          this.performanceMetrics.totalTasks++;
          this.performanceMetrics.queuedTasks++;
          
          // Add task to priority queue
          this.addTaskToPriorityQueue(wrappedTask);
          
          // Immediate scheduling for high-priority tasks
          if (priority > 5) {
              setImmediate(() => this.scheduleQueueProcessingSafe());
          } else {
              this.scheduleQueueProcessingSafe();
          }
      });
  }

  addTaskToPriorityQueue(wrappedTask) {
      const priority = wrappedTask.priority;
      if (!this.priorityQueues.has(priority)) {
          this.priorityQueues.set(priority, []);
      }
      this.priorityQueues.get(priority).push(wrappedTask);
      this.totalQueuedTasks++;
  }

  getNextTask() {
      if (this.totalQueuedTasks === 0) {
          return null;
      }

      const priorities = Array.from(this.priorityQueues.keys()).sort((a, b) => b - a);
      
      for (const priority of priorities) {
          const queue = this.priorityQueues.get(priority);
          if (queue && queue.length > 0) {
              const task = queue.shift();
              this.performanceMetrics.queuedTasks--;
              this.totalQueuedTasks--;
              
              // Clean up empty priority queues
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

  syncQueueCache() {
      let actualTotal = 0;
      for (const queue of this.priorityQueues.values()) {
          actualTotal += queue.length;
      }
      
      if (this.totalQueuedTasks !== actualTotal) {
          console.warn(`Queue cache inconsistency: cached=${this.totalQueuedTasks}, actual=${actualTotal}`);
          this.totalQueuedTasks = actualTotal;
      }
  }

  scheduleQueueProcessingSafe() {
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

  async processQueueSafely() {
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
          
          if ((this.pendingProcess || hadPendingBefore) && !this.isShuttingDown) {
              setImmediate(() => this.processQueueSafely());
          }
      }
  }

  async processQueue() {
      const effectiveMaxWorkers = this.getEffectiveMaxWorkers();
      
      while (this.activeWorkers < effectiveMaxWorkers && this.totalQueuedTasks > 0 && !this.isShuttingDown) {
          const nextTask = this.getNextTask();
          if (!nextTask) {
              break;
          }
          
          // Start task without waiting
          this.runTaskOptimized(nextTask);
      }
  }

  getEffectiveMaxWorkers() {
      if (this.isShuttingDown || this.emergencyMode) {
          return 0;
      }
      
      if (this.circuitBreaker.isOpen) {
          return 0;
      }
      
      if (this.isDegraded) {
          return Math.max(1, Math.floor(this.maxWorkers * this.degradationFactor));
      }
      
      return this.maxWorkers;
  }

  async runTaskOptimized(wrappedTask) {
      if (this.isShuttingDown || this.emergencyMode) {
          wrappedTask.reject(new Error('Worker pool is shutting down'));
          return;
      }

      this.activeWorkers++;
      this.performanceMetrics.peakConcurrency = Math.max(this.performanceMetrics.peakConcurrency, this.activeWorkers);

      // Track executing task
      this.executingTasks.set(wrappedTask.id, {
          startTime: Date.now(),
          timeout: wrappedTask.timeout
      });

      let timeoutId = null;
      let completed = false;
      const taskStartTime = Date.now();
      
      const complete = (success, result) => {
          if (completed) return false;
          completed = true;
          
          // Clean up
          if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
          }
          
          this.executingTasks.delete(wrappedTask.id);
          
          // Update performance metrics
          const executionTime = Date.now() - taskStartTime;
          this.updatePerformanceMetrics(success, executionTime);
          
          if (success) {
              this.performanceMetrics.completedTasks++;
              this.recordCircuitBreakerSuccess();
              wrappedTask.resolve(result);
          } else {
              this.performanceMetrics.failedTasks++;
              this.recordCircuitBreakerFailure();
              wrappedTask.reject(result);
          }
          
          return true;
      };

      try {
          // Set up aggressive timeout
          timeoutId = setTimeout(() => {
              if (complete(false, new Error(`Task timeout after ${wrappedTask.timeout}ms`))) {
                  this.performanceMetrics.timeouts++;
              }
          }, wrappedTask.timeout);

          // Execute task with error boundary
          const result = await this.executeTaskWithErrorBoundary(wrappedTask.task);
          complete(true, result);
          
      } catch (error) {
          if (complete(false, error)) {
              this.recordError();
          }
      } finally {
          this.activeWorkers--;
          
          if (!this.isShuttingDown && this.totalQueuedTasks > 0) {
              this.scheduleQueueProcessingSafe();
          }
      }
  }

  async executeTaskWithErrorBoundary(task) {
      try {
          return await task();
      } catch (error) {
          // Enhanced error classification
          if (error.name === 'AbortError') {
              throw new Error('Task was aborted');
          }
          
          if (error.message && error.message.includes('timeout')) {
              throw new Error('Task execution timeout');
          }
          
          throw error;
      }
  }

  updatePerformanceMetrics(success, executionTime) {
      this.performanceMetrics.lastExecutionTime = Date.now();
      
      if (success) {
          // Update average execution time
          const completedTasks = this.performanceMetrics.completedTasks;
          const currentAvg = this.performanceMetrics.avgExecutionTime;
          this.performanceMetrics.avgExecutionTime = 
              (currentAvg * completedTasks + executionTime) / (completedTasks + 1);
      }
  }

  recordCircuitBreakerSuccess() {
      this.circuitBreaker.successCount++;
      
      if (this.circuitBreaker.isOpen && this.circuitBreaker.successCount >= this.circuitBreaker.successThreshold) {
          this.circuitBreaker.isOpen = false;
          this.circuitBreaker.failureCount = 0;
          console.info('Worker pool circuit breaker closed after successful executions');
      }
  }

  recordCircuitBreakerFailure() {
      this.circuitBreaker.failureCount++;
      this.circuitBreaker.lastFailureTime = Date.now();
      this.circuitBreaker.successCount = 0;
      
      if (this.circuitBreaker.failureCount >= this.circuitBreaker.failureThreshold) {
          this.circuitBreaker.isOpen = true;
          console.warn(`Worker pool circuit breaker opened after ${this.circuitBreaker.failureCount} failures`);
      }
  }

  recordError() {
      const now = Date.now();
      this.errorTimestamps.push(now);
      
      if (!this.isDegraded && now - this.lastDegradationCheck > this.degradationCooldown) {
          if (this.errorTimestamps.length >= this.maxErrorsPerWindow) {
              this.isDegraded = true;
              this.lastDegradationCheck = now;
              this.performanceMetrics.degradationEvents++;
              console.warn(`Worker pool degraded due to ${this.errorTimestamps.length} errors in ${this.errorWindow}ms`);
          }
      }
  }

  isOverloaded() {
      const effectiveMaxWorkers = this.getEffectiveMaxWorkers();
      if (effectiveMaxWorkers === 0) return true;
      
      const utilization = this.activeWorkers / effectiveMaxWorkers;
      const queueUtilization = this.totalQueuedTasks / this.maxQueueSize;
      
      // More aggressive overload detection
      return utilization >= this.backpressureThreshold || 
             queueUtilization >= this.backpressureThreshold ||
             this.circuitBreaker.isOpen ||
             this.emergencyMode;
  }

  generateTaskId() {
      return `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  getStatus() {
      const effectiveMaxWorkers = this.getEffectiveMaxWorkers();
      const utilizationPercent = effectiveMaxWorkers > 0 ? 
          (this.activeWorkers / effectiveMaxWorkers * 100).toFixed(1) + '%' : '0%';
      const queueUtilizationPercent = (this.totalQueuedTasks / this.maxQueueSize * 100).toFixed(1) + '%';
      
      return {
          // Basic status
          activeWorkers: this.activeWorkers,
          queuedTasks: this.totalQueuedTasks,
          maxWorkers: this.maxWorkers,
          effectiveMaxWorkers,
          utilization: utilizationPercent,
          queueUtilization: queueUtilizationPercent,
          
          // Health status
          isDegraded: this.isDegraded,
          isOverloaded: this.isOverloaded(),
          isShuttingDown: this.isShuttingDown,
          emergencyMode: this.emergencyMode,
          
          // Circuit breaker
          circuitBreaker: {
              isOpen: this.circuitBreaker.isOpen,
              failureCount: this.circuitBreaker.failureCount,
              successCount: this.circuitBreaker.successCount,
              timeSinceLastFailure: this.circuitBreaker.lastFailureTime > 0 ? 
                  Date.now() - this.circuitBreaker.lastFailureTime : null
          },
          
          // Performance metrics
          stats: { ...this.performanceMetrics },
          
          // Execution tracking
          executingTasks: this.executingTasks.size,
          recentErrors: this.errorTimestamps.length,
          priorityQueues: this.priorityQueues.size,
          
          // Computed metrics
          successRate: this.performanceMetrics.totalTasks > 0 ? 
              ((this.performanceMetrics.completedTasks / this.performanceMetrics.totalTasks) * 100).toFixed(1) + '%' : '0%',
          timeoutRate: this.performanceMetrics.totalTasks > 0 ? 
              ((this.performanceMetrics.timeouts / this.performanceMetrics.totalTasks) * 100).toFixed(1) + '%' : '0%',
          avgExecutionTime: Math.round(this.performanceMetrics.avgExecutionTime),
          
          version: '2.0.3-optimized'
      };
  }

  isAtCapacity() {
      return this.activeWorkers >= this.getEffectiveMaxWorkers() || this.isOverloaded();
  }

  getPendingCount() {
      return this.totalQueuedTasks;
  }

  clearQueue(reason = 'Queue cleared') {
      let clearedCount = 0;
      
      for (const [priority, queue] of this.priorityQueues) {
          while (queue.length > 0) {
              const task = queue.shift();
              clearedCount++;
              this.performanceMetrics.queuedTasks--;
              this.performanceMetrics.failedTasks++;
              task.reject(new Error(`Task cancelled - ${reason}`));
          }
      }
      
      this.priorityQueues.clear();
      this.totalQueuedTasks = 0;
      
      if (clearedCount > 0) {
          console.info(`Cleared ${clearedCount} queued tasks: ${reason}`);
      }
      
      return clearedCount;
  }

  setMaxWorkers(newMax) {
      if (newMax < 1 || newMax > 16) { // Жесткий лимит
          throw new Error('Max workers must be between 1 and 16');
      }
      
      const oldMax = this.maxWorkers;
      this.maxWorkers = newMax;
      
      // Adjust queue size proportionally
      this.maxQueueSize = Math.max(newMax * 2, 8);
      
      console.info(`Worker pool max workers changed from ${oldMax} to ${newMax}`);
      
      if (newMax > oldMax && !this.isShuttingDown && this.totalQueuedTasks > 0) {
          this.scheduleQueueProcessingSafe();
      }
  }

  async waitForIdle(timeout = 15000) { // Уменьшен таймаут
      const startTime = Date.now();
      
      while ((this.activeWorkers > 0 || this.totalQueuedTasks > 0) && !this.isShuttingDown) {
          if (Date.now() - startTime > timeout) {
              return false;
          }
          await new Promise(resolve => setTimeout(resolve, 50)); // Более частая проверка
      }
      
      return true;
  }

  enableEmergencyMode(reason = 'Emergency mode activated') {
      this.emergencyMode = true;
      console.warn(`Worker pool emergency mode enabled: ${reason}`);
      
      // Clear all queued tasks
      this.clearQueue('Emergency mode');
      
      // Force circuit breaker open
      this.circuitBreaker.isOpen = true;
      this.circuitBreaker.lastFailureTime = Date.now();
  }

  disableEmergencyMode() {
      this.emergencyMode = false;
      this.circuitBreaker.isOpen = false;
      this.circuitBreaker.failureCount = 0;
      console.info('Worker pool emergency mode disabled');
  }

  async shutdown(timeout = 10000) { // Уменьшен таймаут
      if (this.shutdownPromise) {
          return this.shutdownPromise;
      }
      
      this.shutdownPromise = this._performOptimizedShutdown(timeout);
      return this.shutdownPromise;
  }

  async _performOptimizedShutdown(timeout) {
      console.info('Shutting down optimized worker pool...');
      this.isShuttingDown = true;
      
      // Stop error cleanup timer
      if (this.errorCleanupTimer) {
          clearInterval(this.errorCleanupTimer);
          this.errorCleanupTimer = null;
      }
      
      // Clear queue immediately
      const clearedTasks = this.clearQueue('Worker pool shutdown');
      
      // Force-abort long-running tasks
      for (const [taskId, taskInfo] of this.executingTasks) {
          const runningTime = Date.now() - taskInfo.startTime;
          if (runningTime > 5000) { // Abort tasks running longer than 5 seconds
              console.warn(`Force-aborting long-running task ${taskId} (${runningTime}ms)`);
              this.executingTasks.delete(taskId);
          }
      }
      
      // Wait for active tasks with aggressive timeout
      const completed = await this.waitForIdle(Math.min(timeout, 5000));
      
      if (!completed) {
          console.warn(`Optimized worker pool shutdown timeout - ${this.activeWorkers} tasks still running`);
          // Force emergency mode to reject any remaining tasks
          this.enableEmergencyMode('Shutdown timeout');
      } else {
          console.info('Optimized worker pool shutdown completed');
      }
      
      // Final cleanup
      this.executingTasks.clear();
      
      return completed;
  }
}

module.exports = WorkerPool;