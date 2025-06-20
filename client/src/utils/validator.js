// src/utils/validator.js

/**
 * Validates host format (domain or IP address)
 * @param {string} host - Host to validate
 * @returns {boolean} - True if valid
 */
function validateHost(host) {
    if (!host || typeof host !== 'string') {
      return false;
    }
  
    // Remove protocol if present
    const cleanHost = host.replace(/^https?:\/\//, '');
    
    // Check for valid domain format
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-_.]*[a-zA-Z0-9]$/;
    
    // Check for valid IP address format
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    
    return domainRegex.test(cleanHost) || ipRegex.test(cleanHost);
  }
  
  /**
   * Validates port number
   * @param {number|string} port - Port to validate
   * @returns {boolean} - True if valid
   */
  function validatePort(port) {
    const portNum = parseInt(port, 10);
    return !isNaN(portNum) && portNum >= 1 && portNum <= 65535;
  }
  
  /**
   * Validates path format (must start with /)
   * @param {string} path - Path to validate
   * @returns {boolean} - True if valid
   */
  function validatePath(path) {
    if (!path || typeof path !== 'string') {
      return false;
    }
    
    return path.startsWith('/') && path.length > 1;
  }
  
  /**
   * Validates and parses forward rule
   * @param {string} rule - Forward rule in format "PORT:PATH" or "PORT"
   * @returns {object|null} - Parsed rule object or null if invalid
   */
  function validateForwardRule(rule) {
    if (!rule || typeof rule !== 'string') {
      return null;
    }
  
    const parts = rule.split(':');
    
    // Format: "PORT" (root path)
    if (parts.length === 1) {
      const port = parts[0];
      if (!validatePort(port)) {
        return null;
      }
      return {
        port: parseInt(port, 10),
        path: '/'
      };
    }
    
    // Format: "PORT:PATH"
    if (parts.length === 2) {
      const [port, path] = parts;
      if (!validatePort(port) || !validatePath(path)) {
        return null;
      }
      return {
        port: parseInt(port, 10),
        path: path
      };
    }
    
    return null;
  }
  
  /**
   * Validates concurrency value
   * @param {number|string} concurrency - Concurrency value to validate
   * @returns {boolean} - True if valid
   */
  function validateConcurrency(concurrency) {
    const concurrencyNum = parseInt(concurrency, 10);
    return !isNaN(concurrencyNum) && concurrencyNum >= 1 && concurrencyNum <= 1000;
  }
  
  /**
   * Validates auth key format and security requirements
   * @param {string} authKey - Auth key to validate
   * @returns {boolean} - True if valid
   */
  function validateAuthKey(authKey) {
    if (!authKey || typeof authKey !== 'string') {
      return false;
    }
    
    // Check length requirements
    if (authKey.length < 8 || authKey.length > 128) {
      return false;
    }
    
    // Check for valid characters (alphanumeric, dashes, underscores, dots)
    const validCharsRegex = /^[a-zA-Z0-9_.-]+$/;
    return validCharsRegex.test(authKey);
  }
  
  /**
   * Validates prefix for URL path segments
   * @param {string} prefix - Prefix to validate (can be empty)
   * @returns {boolean} - True if valid
   */
  function validatePrefix(prefix) {
    // Empty prefix is valid (default behavior)
    if (!prefix || prefix === '') {
      return true;
    }
    
    if (typeof prefix !== 'string') {
      return false;
    }
    
    // Check length limit
    if (prefix.length > 64) {
      return false;
    }
    
    // Should not start or end with slash
    if (prefix.startsWith('/') || prefix.endsWith('/')) {
      return false;
    }
    
    // Should contain only valid URL path characters
    const validPrefixRegex = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;
    return validPrefixRegex.test(prefix);
  }
  
  module.exports = {
    validateHost,
    validatePort,
    validatePath,
    validateForwardRule,
    validateConcurrency,
    validateAuthKey,
    validatePrefix
  };