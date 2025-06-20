// src/tunnel-manager.js

export default class TunnelManager {
  /**
   * Creates a new tunnel manager
   * @param {Map} activeTunnels - Global tunnels storage
   * @param {RequestQueue} requestQueue - Request queue manager for cleanup
   */
  constructor(activeTunnels, requestQueue = null) {
    this.activeTunnels = activeTunnels;
    this.requestQueue = requestQueue; // Add reference to request queue for cleanup
    this.tunnelTimeout = 10 * 60 * 1000; // 10 minutes
    this.lastCleanup = Date.now();
    this.cleanupInterval = 60000; // 1 minute
    this.cleanupTimer = null;
    
    // Start automatic cleanup
    this.startPeriodicCleanup();
  }

  /**
   * Registers a new tunnel
   * @param {object} registrationData - Registration data from client
   * @returns {object} - Registration response
   */
  async registerTunnel(registrationData) {
    const { forward_rules, client_info } = registrationData;

    // Validate input
    if (!forward_rules || !Array.isArray(forward_rules) || forward_rules.length === 0) {
      throw new Error('Invalid or missing forward_rules');
    }

    if (!client_info) {
      throw new Error('Missing client_info');
    }

    // Validate forward rules
    const validatedRules = this.validateForwardRules(forward_rules);

    // Generate unique tunnel ID
    const tunnelId = this.generateTunnelId();

    // Create tunnel metadata
    const tunnel = {
      id: tunnelId,
      created_at: Date.now(),
      last_seen: Date.now(),
      forward_rules: validatedRules,
      client_info: {
        version: client_info.version || 'unknown',
        concurrency: client_info.concurrency || 16,
        local_host: client_info.local_host || 'localhost',
        features: client_info.features || {}
      },
      status: 'active',
      last_poll: Date.now(), // Track when client last polled
      polls_count: 0 // Track polling activity
    };

    // Store tunnel
    this.activeTunnels.set(tunnelId, tunnel);

    console.log(`Tunnel registered: ${tunnelId} with ${validatedRules.length} rules`);

    return {
      tunnel_id: tunnelId,
      public_url: this.workerHost,
      rules_registered: validatedRules.length,
      expires_in: this.tunnelTimeout
    };
  }

  /**
   * Unregisters a tunnel with proper cleanup
   * @param {string} tunnelId - Tunnel ID to remove
   */
  async unregisterTunnel(tunnelId) {
    if (!tunnelId) {
      throw new Error('Missing tunnel_id');
    }

    const tunnel = this.activeTunnels.get(tunnelId);
    if (!tunnel) {
      throw new Error('Tunnel not found');
    }

    // Clean up tunnel data
    await this.cleanupTunnel(tunnelId);
    
    console.log(`Tunnel unregistered and cleaned up: ${tunnelId}`);
  }

  /**
   * Properly cleans up all tunnel data
   * @param {string} tunnelId - Tunnel ID to clean up
   */
  async cleanupTunnel(tunnelId) {
    // Remove tunnel from active tunnels
    this.activeTunnels.delete(tunnelId);
    
    // Clean up request queue if available
    if (this.requestQueue) {
      this.requestQueue.cancelTunnelRequests(tunnelId);
    }
    
    console.log(`Cleaned up all data for tunnel: ${tunnelId}`);
  }

  /**
   * Updates polling activity for a tunnel
   * @param {string} tunnelId - Tunnel ID
   */
  updatePollingActivity(tunnelId) {
    const tunnel = this.activeTunnels.get(tunnelId);
    if (tunnel) {
      tunnel.last_poll = Date.now();
      tunnel.polls_count = (tunnel.polls_count || 0) + 1;
      tunnel.last_seen = Date.now(); // Also update last_seen
    }
  }

  /**
   * Finds tunnel that matches the given path
   * @param {string} requestPath - Request path to match
   * @returns {object|null} - Matching tunnel or null
   */
  findTunnelByPath(requestPath) {
    if (!requestPath || typeof requestPath !== 'string') {
      return null;
    }

    // Normalize path
    const normalizedPath = requestPath.startsWith('/') ? requestPath : '/' + requestPath;

    let bestMatch = null;
    let longestMatch = -1;

    // Find the most specific matching tunnel (longest path match)
    for (const [tunnelId, tunnel] of this.activeTunnels) {
      if (tunnel.status !== 'active') {
        continue;
      }

      // Check if tunnel is recently active (polled within last 2 minutes)
      const timeSinceLastPoll = Date.now() - (tunnel.last_poll || tunnel.last_seen);
      if (timeSinceLastPoll > 2 * 60 * 1000) {
        console.warn(`Tunnel ${tunnelId} found but hasn't polled recently (${Math.round(timeSinceLastPoll/1000)}s ago)`);
        continue; // Skip inactive tunnels
      }

      for (const rule of tunnel.forward_rules) {
        if (this.pathMatches(normalizedPath, rule.path)) {
          // Prefer longer, more specific paths
          if (rule.path.length > longestMatch) {
            longestMatch = rule.path.length;
            bestMatch = {
              id: tunnelId,
              tunnel: tunnel,
              rule: rule
            };
          }
        }
      }
    }

    return bestMatch;
  }

  /**
   * Checks if request path matches rule path with proper boundary checking
   * @param {string} requestPath - Request path
   * @param {string} rulePath - Rule path to match against
   * @returns {boolean} - True if paths match
   */
  pathMatches(requestPath, rulePath) {
    // Root path matches everything
    if (rulePath === '/') {
      return true;
    }

    // Exact match
    if (requestPath === rulePath) {
      return true;
    }

    // Prefix match with proper boundary checking
    if (requestPath.startsWith(rulePath)) {
      const nextChar = requestPath[rulePath.length];
      // Must be followed by slash, query string, or hash
      return nextChar === '/' || nextChar === '?' || nextChar === '#' || nextChar === undefined;
    }

    return false;
  }

  /**
   * Checks if tunnel is active and recently polled
   * @param {string} tunnelId - Tunnel ID to check
   * @returns {boolean} - True if tunnel exists and is active
   */
  isActive(tunnelId) {
    const tunnel = this.activeTunnels.get(tunnelId);
    if (!tunnel || tunnel.status !== 'active') {
      return false;
    }
    
    // Check if tunnel has polled recently
    const timeSinceLastPoll = Date.now() - (tunnel.last_poll || tunnel.last_seen);
    return timeSinceLastPoll < 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Updates tunnel heartbeat timestamp
   * @param {string} tunnelId - Tunnel ID
   */
  updateHeartbeat(tunnelId) {
    const tunnel = this.activeTunnels.get(tunnelId);
    if (tunnel) {
      tunnel.last_seen = Date.now();
    }
  }

  /**
   * Starts periodic cleanup of inactive tunnels
   */
  startPeriodicCleanup() {
    // Clear any existing timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    // Start new cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanupInactiveTunnels();
    }, this.cleanupInterval);
    
    console.log('Started periodic tunnel cleanup timer');
  }

  /**
   * Stops periodic cleanup
   */
  stopPeriodicCleanup() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      console.log('Stopped periodic tunnel cleanup timer');
    }
  }

  /**
   * Removes inactive tunnels that haven't sent heartbeat or polled
   */
  cleanupInactiveTunnels() {
    const now = Date.now();
    const expired = [];
    const warnings = [];

    for (const [tunnelId, tunnel] of this.activeTunnels) {
      const timeSinceLastSeen = now - tunnel.last_seen;
      const timeSinceLastPoll = now - (tunnel.last_poll || tunnel.last_seen);

      // Mark as expired if no heartbeat for tunnel timeout period
      if (timeSinceLastSeen > this.tunnelTimeout) {
        expired.push({
          id: tunnelId,
          reason: `No heartbeat for ${Math.round(timeSinceLastSeen/1000)}s`
        });
      }
      // Also mark as expired if no polling activity for extended period
      else if (timeSinceLastPoll > this.tunnelTimeout * 0.5) {
        expired.push({
          id: tunnelId,
          reason: `No polling for ${Math.round(timeSinceLastPoll/1000)}s`
        });
      }
      // Warn about tunnels that haven't polled recently
      else if (timeSinceLastPoll > 2 * 60 * 1000) {
        warnings.push({
          id: tunnelId,
          lastPoll: Math.round(timeSinceLastPoll/1000)
        });
      }
    }

    // Log warnings for inactive tunnels
    for (const warning of warnings) {
      console.warn(`Tunnel ${warning.id} hasn't polled for ${warning.lastPoll}s`);
    }

    // Remove expired tunnels
    for (const expiredTunnel of expired) {
      this.cleanupTunnel(expiredTunnel.id);
      console.log(`Cleaned up expired tunnel: ${expiredTunnel.id} (${expiredTunnel.reason})`);
    }

    if (expired.length > 0) {
      console.log(`Cleanup completed: removed ${expired.length} expired tunnels`);
    }

    // Update last cleanup time
    this.lastCleanup = now;
  }

  /**
   * Validates forward rules from client
   * @param {Array} rules - Forward rules to validate
   * @returns {Array} - Validated rules
   */
  validateForwardRules(rules) {
    const validated = [];
    const seenPaths = new Set();

    for (const rule of rules) {
      // Validate rule structure
      if (!rule || typeof rule !== 'object') {
        throw new Error('Invalid rule format');
      }

      const { port, path } = rule;

      // Validate port
      if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${port}`);
      }

      // Validate path
      if (!path || typeof path !== 'string' || !path.startsWith('/')) {
        throw new Error(`Invalid path: ${path}`);
      }

      // Check for duplicate paths
      if (seenPaths.has(path)) {
        throw new Error(`Duplicate path: ${path}`);
      }
      seenPaths.add(path);

      validated.push({
        port: port,
        path: path
      });
    }

    // Sort rules by path specificity (longer paths first, root last)
    validated.sort((a, b) => {
      if (a.path === '/') return 1;
      if (b.path === '/') return -1;
      return b.path.length - a.path.length;
    });

    return validated;
  }

  /**
   * Generates unique tunnel ID
   * @returns {string} - Unique tunnel ID
   */
  generateTunnelId() {
    return `tunnel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Gets statistics about active tunnels
   * @returns {object} - Tunnel statistics
   */
  getStats() {
    const totalTunnels = this.activeTunnels.size;
    const now = Date.now();
    let activeTunnels = 0;
    let recentlyPolled = 0;
    let totalRules = 0;
    let totalPolls = 0;

    for (const [tunnelId, tunnel] of this.activeTunnels) {
      if (tunnel.status === 'active') {
        activeTunnels++;
        totalRules += tunnel.forward_rules.length;
        totalPolls += tunnel.polls_count || 0;
        
        const timeSinceLastPoll = now - (tunnel.last_poll || tunnel.last_seen);
        if (timeSinceLastPoll < 2 * 60 * 1000) {
          recentlyPolled++;
        }
      }
    }

    return {
      total_tunnels: totalTunnels,
      active_tunnels: activeTunnels,
      recently_polled: recentlyPolled,
      total_rules: totalRules,
      total_polls: totalPolls,
      cleanup_timeout: this.tunnelTimeout,
      cleanup_running: this.cleanupTimer !== null
    };
  }

  /**
   * Lists all active tunnels (for debugging)
   * @returns {Array} - Array of tunnel info
   */
  listTunnels() {
    const tunnels = [];

    for (const [tunnelId, tunnel] of this.activeTunnels) {
      const now = Date.now();
      tunnels.push({
        id: tunnelId,
        status: tunnel.status,
        created_at: tunnel.created_at,
        last_seen: tunnel.last_seen,
        last_poll: tunnel.last_poll,
        time_since_last_poll: tunnel.last_poll ? now - tunnel.last_poll : null,
        polls_count: tunnel.polls_count || 0,
        rules_count: tunnel.forward_rules.length,
        client_version: tunnel.client_info.version
      });
    }

    return tunnels;
  }

  /**
   * Emergency cleanup - removes all tunnels (for shutdown)
   */
  shutdown() {
    this.stopPeriodicCleanup();
    
    // Clean up all tunnels
    const tunnelIds = Array.from(this.activeTunnels.keys());
    for (const tunnelId of tunnelIds) {
      this.cleanupTunnel(tunnelId);
    }
    
    console.log(`Tunnel manager shutdown: cleaned up ${tunnelIds.length} tunnels`);
  }
}