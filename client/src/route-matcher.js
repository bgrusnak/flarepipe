class RouteMatcher {
    /**
     * Creates a new route matcher
     * @param {Array} forwardRules - Array of {port, path} objects
     */
    constructor(forwardRules) {
      if (!Array.isArray(forwardRules)) {
        throw new Error('Forward rules must be an array');
      }
      
      // Sort rules by path specificity (longer paths first, root path last)
      this.rules = forwardRules.sort((a, b) => {
        if (a.path === '/') return 1;
        if (b.path === '/') return -1;
        return b.path.length - a.path.length;
      });
    }
  
    /**
     * Finds matching rule for the given request path
     * @param {string} requestPath - Incoming request path
     * @returns {object|null} - Matching rule or null if no match
     */
    match(requestPath) {
      if (!requestPath || typeof requestPath !== 'string') {
        return null;
      }
  
      // Ensure path starts with /
      const normalizedPath = requestPath.startsWith('/') ? requestPath : '/' + requestPath;
  
      for (const rule of this.rules) {
        if (this.pathMatches(normalizedPath, rule.path)) {
          return rule;
        }
      }
  
      return null;
    }
  
    /**
     * Checks if request path matches rule path
     * @param {string} requestPath - Request path to check
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
  
      // Prefix match (path must be followed by / or end of string)
      if (requestPath.startsWith(rulePath)) {
        const nextChar = requestPath[rulePath.length];
        return nextChar === '/' || nextChar === undefined;
      }
  
      return false;
    }
  
    /**
     * Gets all configured rules
     * @returns {Array} - Array of all rules
     */
    getRules() {
      return [...this.rules];
    }
  
    /**
     * Adds a new rule
     * @param {object} rule - Rule to add {port, path}
     */
    addRule(rule) {
      if (!rule || typeof rule.port !== 'number' || typeof rule.path !== 'string') {
        throw new Error('Invalid rule format');
      }
  
      this.rules.push(rule);
      // Re-sort after adding
      this.rules.sort((a, b) => {
        if (a.path === '/') return 1;
        if (b.path === '/') return -1;
        return b.path.length - a.path.length;
      });
    }
  
    /**
     * Removes all rules
     */
    clearRules() {
      this.rules = [];
    }
  }
  
  module.exports = RouteMatcher;