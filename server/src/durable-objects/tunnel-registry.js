// server/src/durable-objects/tunnel-registry.js

export class TunnelRegistry {
    constructor(state, env) {
      this.state = state;
      this.env = env;
      this.storage = state.storage;
      
      // In-memory cache for performance
      this.activeTunnels = new Map();
      this.initialized = false;
      
      // Configuration
      this.tunnelTimeout = 10 * 60 * 1000; // 10 minutes
      this.cleanupInterval = 60 * 1000; // 1 minute
      this.maxTunnels = 100; // Safety limit
      
      // Start cleanup timer
      this.startCleanupTimer();
    }
  
    /**
     * Update polling activity
     */
    async handleUpdatePolling(request) {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
  
      const { tunnel_id } = await request.json();
      
      if (!tunnel_id) {
        return new Response(JSON.stringify({ error: 'Missing tunnel_id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      const success = await this.updatePollingActivity(tunnel_id);
      
      return new Response(JSON.stringify({ success }), {
        status: success ? 200 : 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  
    /**
     * Initialize from persistent storage
     */
    async initialize() {
      if (this.initialized) return;
      
      try {
        // Load all tunnels from storage
        const tunnelEntries = await this.storage.list({ prefix: "tunnel:" });
        
        for (const [key, tunnel] of tunnelEntries) {
          const tunnelId = key.replace("tunnel:", "");
          this.activeTunnels.set(tunnelId, tunnel);
        }
        
        console.log(`TunnelRegistry initialized with ${this.activeTunnels.size} tunnels`);
        this.initialized = true;
        
        // Cleanup stale tunnels on startup
        await this.cleanupStaleTunnels();
        
      } catch (error) {
        console.error("Failed to initialize TunnelRegistry:", error);
        this.initialized = true; // Continue anyway
      }
    }
  
    /**
     * Handle HTTP requests to this Durable Object
     */
    async fetch(request) {
      await this.initialize();
      
      const url = new URL(request.url);
      const path = url.pathname;
      
      try {
        switch (path) {
          case '/register':
            return await this.handleRegister(request);
          case '/unregister':
            return await this.handleUnregister(request);
          case '/heartbeat':
            return await this.handleHeartbeat(request);
          case '/update-polling':
            return await this.handleUpdatePolling(request);
          case '/find-tunnel':
            return await this.handleFindTunnel(request);
          case '/list-tunnels':
            return await this.handleListTunnels(request);
          case '/stats':
            return await this.handleStats(request);
          default:
            return new Response('Not Found', { status: 404 });
        }
      } catch (error) {
        console.error('TunnelRegistry error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  
    /**
     * Register a new tunnel
     */
    async handleRegister(request) {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
  
      const registrationData = await request.json();
      const { forward_rules, client_info } = registrationData;
  
      // Validate input
      if (!forward_rules || !Array.isArray(forward_rules) || forward_rules.length === 0) {
        return new Response(JSON.stringify({ error: 'Invalid forward_rules' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      // Check tunnel limits
      if (this.activeTunnels.size >= this.maxTunnels) {
        return new Response(JSON.stringify({ error: 'Tunnel limit reached' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      // Clean up conflicting tunnels (same paths)
      const cleanedCount = await this.cleanupConflictingTunnels(forward_rules);
  
      // Generate tunnel ID
      const tunnelId = this.generateTunnelId();
      const now = Date.now();
  
      // Create tunnel object
      const tunnel = {
        id: tunnelId,
        created_at: now,
        last_seen: now,
        last_poll: now,
        forward_rules: this.validateAndSortRules(forward_rules),
        client_info: {
          version: client_info?.version || 'unknown',
          concurrency: client_info?.concurrency || 16,
          local_host: client_info?.local_host || 'localhost',
          features: client_info?.features || {}
        },
        status: 'active',
        polls_count: 0,
        requests_count: 0
      };
  
      // Store in memory and persistent storage
      this.activeTunnels.set(tunnelId, tunnel);
      await this.storage.put(`tunnel:${tunnelId}`, tunnel);
  
      console.log(`Tunnel registered: ${tunnelId} (cleaned ${cleanedCount} conflicts)`);
  
      return new Response(JSON.stringify({
        tunnel_id: tunnelId,
        rules_registered: tunnel.forward_rules.length,
        expires_in: this.tunnelTimeout,
        replaced_tunnels: cleanedCount
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  
    /**
     * Unregister a tunnel
     */
    async handleUnregister(request) {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
  
      const { tunnel_id } = await request.json();
      
      if (!tunnel_id) {
        return new Response(JSON.stringify({ error: 'Missing tunnel_id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      const success = await this.removeTunnel(tunnel_id);
      
      return new Response(JSON.stringify({ 
        success,
        message: success ? 'Tunnel unregistered' : 'Tunnel not found'
      }), {
        status: success ? 200 : 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  
    /**
     * Update tunnel heartbeat
     */
    async handleHeartbeat(request) {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
  
      const { tunnel_id } = await request.json();
      
      if (!tunnel_id) {
        return new Response(JSON.stringify({ error: 'Missing tunnel_id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      const tunnel = this.activeTunnels.get(tunnel_id);
      if (!tunnel) {
        return new Response(JSON.stringify({ error: 'Tunnel not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      // Update heartbeat
      tunnel.last_seen = Date.now();
      this.activeTunnels.set(tunnel_id, tunnel);
      await this.storage.put(`tunnel:${tunnel_id}`, tunnel);
  
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  
    /**
     * Find tunnel by path
     */
    async handleFindTunnel(request) {
      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
      }
  
      const url = new URL(request.url);
      const path = url.searchParams.get('path');
      
      if (!path) {
        return new Response(JSON.stringify({ error: 'Missing path parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      const tunnel = await this.findTunnelByPath(path);
      
      if (!tunnel) {
        return new Response(JSON.stringify({ error: 'No tunnel found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      // Update request count
      tunnel.tunnel.requests_count = (tunnel.tunnel.requests_count || 0) + 1;
      this.activeTunnels.set(tunnel.id, tunnel.tunnel);
      
      // Don't await - update async for performance
      this.storage.put(`tunnel:${tunnel.id}`, tunnel.tunnel);
  
      return new Response(JSON.stringify({
        tunnel_id: tunnel.id,
        rule: tunnel.rule
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  
    /**
     * Update polling activity
     */
    async updatePollingActivity(tunnelId) {
      const tunnel = this.activeTunnels.get(tunnelId);
      if (!tunnel) return false;
  
      tunnel.last_poll = Date.now();
      tunnel.polls_count = (tunnel.polls_count || 0) + 1;
      
      this.activeTunnels.set(tunnelId, tunnel);
      
      // Async update for performance
      this.storage.put(`tunnel:${tunnelId}`, tunnel);
      
      return true;
    }
  
    /**
     * Find tunnel by path (internal method)
     */
    async findTunnelByPath(requestPath) {
      if (!requestPath || typeof requestPath !== 'string') {
        return null;
      }
  
      const normalizedPath = requestPath.startsWith('/') ? requestPath : '/' + requestPath;
      const now = Date.now();
  
      let bestMatch = null;
      let longestMatch = -1;
  
      for (const [tunnelId, tunnel] of this.activeTunnels) {
        if (tunnel.status !== 'active') continue;
  
        // Check if tunnel is still alive
        const timeSinceLastSeen = now - tunnel.last_seen;
        if (timeSinceLastSeen > this.tunnelTimeout) {
          // Mark for cleanup but don't use
          continue;
        }
  
        for (const rule of tunnel.forward_rules) {
          if (this.pathMatches(normalizedPath, rule.path)) {
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
     * Check if request path matches rule path
     */
    pathMatches(requestPath, rulePath) {
      if (rulePath === '/') return true;
      if (requestPath === rulePath) return true;
      
      if (requestPath.startsWith(rulePath)) {
        const nextChar = requestPath[rulePath.length];
        return nextChar === '/' || nextChar === '?' || nextChar === '#' || nextChar === undefined;
      }
      
      return false;
    }
  
    /**
     * Clean up conflicting tunnels (same paths)
     */
    async cleanupConflictingTunnels(newRules) {
      const pathsToClean = new Set(newRules.map(r => r.path));
      const toRemove = [];
  
      for (const [tunnelId, tunnel] of this.activeTunnels) {
        for (const rule of tunnel.forward_rules) {
          if (pathsToClean.has(rule.path)) {
            toRemove.push(tunnelId);
            break;
          }
        }
      }
  
      // Remove conflicting tunnels
      for (const tunnelId of toRemove) {
        await this.removeTunnel(tunnelId);
      }
  
      return toRemove.length;
    }
  
    /**
     * Remove tunnel from memory and storage
     */
    async removeTunnel(tunnelId) {
      const tunnel = this.activeTunnels.get(tunnelId);
      if (!tunnel) return false;
  
      this.activeTunnels.delete(tunnelId);
      await this.storage.delete(`tunnel:${tunnelId}`);
      
      console.log(`Tunnel removed: ${tunnelId}`);
      return true;
    }
  
    /**
     * Validate and sort forward rules
     */
    validateAndSortRules(rules) {
      const validated = [];
      const seenPaths = new Set();
  
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        
        const { port, path } = rule;
        if (!port || !path || typeof port !== 'number' || typeof path !== 'string') continue;
        if (port < 1 || port > 65535) continue;
        if (!path.startsWith('/')) continue;
        if (seenPaths.has(path)) continue;
  
        seenPaths.add(path);
        validated.push({ port, path });
      }
  
      // Sort by path specificity
      return validated.sort((a, b) => {
        if (a.path === '/') return 1;
        if (b.path === '/') return -1;
        return b.path.length - a.path.length;
      });
    }
  
    /**
     * Generate unique tunnel ID
     */
    generateTunnelId() {
      return `tunnel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
  
    /**
     * Start cleanup timer
     */
    startCleanupTimer() {
      // Use Durable Object alarm for cleanup
      this.state.storage.setAlarm(Date.now() + this.cleanupInterval);
    }
  
    /**
     * Handle alarm for cleanup
     */
    async alarm() {
      await this.initialize();
      await this.cleanupStaleTunnels();
      
      // Schedule next cleanup
      this.state.storage.setAlarm(Date.now() + this.cleanupInterval);
    }
  
    /**
     * Clean up stale tunnels
     */
    async cleanupStaleTunnels() {
      const now = Date.now();
      const toRemove = [];
  
      for (const [tunnelId, tunnel] of this.activeTunnels) {
        const timeSinceLastSeen = now - tunnel.last_seen;
        
        if (timeSinceLastSeen > this.tunnelTimeout) {
          toRemove.push({
            id: tunnelId,
            reason: `No heartbeat for ${Math.round(timeSinceLastSeen/1000)}s`
          });
        }
      }
  
      for (const expired of toRemove) {
        await this.removeTunnel(expired.id);
        console.log(`Cleaned up expired tunnel: ${expired.id} (${expired.reason})`);
      }
  
      if (toRemove.length > 0) {
        console.log(`Cleanup completed: removed ${toRemove.length} expired tunnels`);
      }
  
      return toRemove.length;
    }
  
    /**
     * Get statistics
     */
    async handleStats(request) {
      const totalTunnels = this.activeTunnels.size;
      const now = Date.now();
      let activeTunnels = 0;
      let recentlyPolled = 0;
      let totalRules = 0;
      let totalPolls = 0;
      let totalRequests = 0;
  
      for (const [tunnelId, tunnel] of this.activeTunnels) {
        if (tunnel.status === 'active') {
          activeTunnels++;
          totalRules += tunnel.forward_rules.length;
          totalPolls += tunnel.polls_count || 0;
          totalRequests += tunnel.requests_count || 0;
          
          const timeSinceLastPoll = now - (tunnel.last_poll || tunnel.last_seen);
          if (timeSinceLastPoll < 2 * 60 * 1000) {
            recentlyPolled++;
          }
        }
      }
  
      const stats = {
        total_tunnels: totalTunnels,
        active_tunnels: activeTunnels,
        recently_polled: recentlyPolled,
        total_rules: totalRules,
        total_polls: totalPolls,
        total_requests: totalRequests,
        cleanup_timeout: this.tunnelTimeout,
        durable_object_id: this.state.id.toString()
      };
  
      return new Response(JSON.stringify(stats, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  
    /**
     * List all tunnels
     */
    async handleListTunnels(request) {
      const tunnels = [];
      const now = Date.now();
  
      for (const [tunnelId, tunnel] of this.activeTunnels) {
        tunnels.push({
          id: tunnelId,
          status: tunnel.status,
          created_at: tunnel.created_at,
          age_seconds: Math.round((now - tunnel.created_at) / 1000),
          last_seen: tunnel.last_seen,
          last_poll: tunnel.last_poll,
          time_since_last_poll: tunnel.last_poll ? now - tunnel.last_poll : null,
          polls_count: tunnel.polls_count || 0,
          requests_count: tunnel.requests_count || 0,
          rules_count: tunnel.forward_rules.length,
          client_version: tunnel.client_info.version,
          rules: tunnel.forward_rules.map(r => `${r.port}:${r.path}`)
        });
      }
  
      return new Response(JSON.stringify(tunnels.sort((a, b) => b.created_at - a.created_at), null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }