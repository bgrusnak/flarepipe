// src/tunnel-manager.js

export default class TunnelManager {
  /**
   * Creates a new tunnel manager
   * @param {Map} activeTunnels - Global tunnels storage
   */
  constructor(activeTunnels) {
    this.activeTunnels = activeTunnels;
    this.tunnelTimeout = 10 * 60 * 1000; // 10 minutes
    this.lastCleanup = Date.now();
    this.cleanupInterval = 60000; // 1 minute
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
      status: 'active'
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
   * Unregisters a tunnel
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

    this.activeTunnels.delete(tunnelId);
    console.log(`Tunnel unregistered: ${tunnelId}`);
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
   * Checks if tunnel is active
   * @param {string} tunnelId - Tunnel ID to check
   * @returns {boolean} - True if tunnel exists and is active
   */
  isActive(tunnelId) {
    const tunnel = this.activeTunnels.get(tunnelId);
    return tunnel && tunnel.status === 'active';
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
   * Starts cleanup timer for inactive tunnels
   */
  startCleanupTimer() {
    // Run cleanup every minute
    setInterval(() => {
      this.cleanupInactiveTunnels();
    }, 60000);
  }

  /**
   * Removes inactive tunnels that haven't sent heartbeat
   */
  cleanupInactiveTunnels() {
    const now = Date.now();
    const expired = [];

    for (const [tunnelId, tunnel] of this.activeTunnels) {
      const timeSinceLastSeen = now - tunnel.last_seen;

      if (timeSinceLastSeen > this.tunnelTimeout) {
        expired.push(tunnelId);
      }
    }

    // Remove expired tunnels
    for (const tunnelId of expired) {
      this.activeTunnels.delete(tunnelId);
      console.log(`Cleaned up inactive tunnel: ${tunnelId}`);
    }

    if (expired.length > 0) {
      console.log(`Cleanup completed: removed ${expired.length} inactive tunnels`);
    }
  }

  /**
   * Gets statistics about active tunnels
   * @returns {object} - Tunnel statistics
   */
  getStats() {
    const totalTunnels = this.activeTunnels.size;
    const now = Date.now();
    let activeTunnels = 0;
    let totalRules = 0;

    for (const [tunnelId, tunnel] of this.activeTunnels) {
      if (tunnel.status === 'active') {
        activeTunnels++;
        totalRules += tunnel.forward_rules.length;
      }
    }

    return {
      total_tunnels: totalTunnels,
      active_tunnels: activeTunnels,
      total_rules: totalRules,
      cleanup_timeout: this.tunnelTimeout
    };
  }

  /**
   * Lists all active tunnels (for debugging)
   * @returns {Array} - Array of tunnel info
   */
  listTunnels() {
    const tunnels = [];

    for (const [tunnelId, tunnel] of this.activeTunnels) {
      tunnels.push({
        id: tunnelId,
        status: tunnel.status,
        created_at: tunnel.created_at,
        last_seen: tunnel.last_seen,
        rules_count: tunnel.forward_rules.length,
        client_version: tunnel.client_info.version
      });
    }

    return tunnels;
  }
}