// server/src/utils/response-builder.js

export default class ResponseBuilder {
  /**
   * Creates a new response builder
   */
  constructor() {
    this.maxResponseSize = 50 * 1024 * 1024; // 50MB limit for CF Worker
    this.defaultHeaders = {
      'X-Tunnel-Proxy': 'flarepipe-server/1.2.0'
    };
    
    // Feature detection
    this.hasBuffer = typeof Buffer !== 'undefined';
    this.hasAtob = typeof atob !== 'undefined';
  }

  /**
   * Builds HTTP Response from tunnel client response data
   * @param {object} responseData - Response data from tunnel client
   * @returns {Response} - HTTP Response object
   */
  async buildResponse(responseData) {
    try {
      // Validate response data
      this.validateResponseData(responseData);
      
      const { status, headers, body } = responseData;
      
      // Process headers (immutable approach)
      const processedHeaders = this.processHeaders(headers);
      
      // Create Response object - body is RAW BINARY, no processing
      const response = new Response(body || '', {
        status: status,
        statusText: this.getStatusText(status),
        headers: processedHeaders
      });
      
      return response;
      
    } catch (error) {
      console.error('Error building response:', error.message);
      return this.createErrorResponse(error);
    }
  }

  /**
   * Validates response data from tunnel client
   * @param {object} responseData - Response data to validate
   */
  validateResponseData(responseData) {
    if (!responseData || typeof responseData !== 'object') {
      throw new Error('Invalid response data');
    }

    // Validate status
    if (typeof responseData.status !== 'number' || 
        responseData.status < 100 || 
        responseData.status > 599) {
      throw new Error(`Invalid HTTP status: ${responseData.status}`);
    }

    // Validate headers
    if (responseData.headers && typeof responseData.headers !== 'object') {
      throw new Error('Invalid headers format');
    }

    // Validate body - MUST be ArrayBuffer for RAW BINARY data
    if (responseData.body) {
      if (!(responseData.body instanceof ArrayBuffer)) {
        throw new Error('Body must be ArrayBuffer for RAW BINARY data');
      }
      
      if (responseData.body.byteLength > this.maxResponseSize) {
        throw new Error(`Response too large: ${responseData.body.byteLength} bytes`);
      }
    }
  }

  /**
   * Processes and normalizes response headers (immutable)
   * @param {object} headers - Headers from tunnel client
   * @returns {Headers} - Processed Headers object
   */
  processHeaders(headers = {}) {
    const processedHeaders = new Headers();
    
    // Add default headers first
    for (const [key, value] of Object.entries(this.defaultHeaders)) {
      processedHeaders.set(key, value);
    }
    
    // Process client headers safely
    const headerEntries = Object.entries(headers || {});
    
    for (const [key, value] of headerEntries) {
      if (this.isValidHeader(key, value)) {
        // Handle special headers
        if (this.isRestrictedHeader(key)) {
          continue; // Skip restricted headers
        }
        
        try {
          processedHeaders.set(key, String(value));
        } catch (error) {
          console.warn(`Failed to set header ${key}:`, error.message);
        }
      }
    }
    
    // Add CORS headers
    for (const [key, value] of Object.entries(this.getCORSHeaders())) {
      processedHeaders.set(key, value);
    }
    
    return processedHeaders;
  }

  /**
   * Checks if header is valid
   * @param {string} key - Header name
   * @param {any} value - Header value
   * @returns {boolean} - True if valid
   */
  isValidHeader(key, value) {
    if (!key || typeof key !== 'string') {
      return false;
    }
    
    if (value === undefined || value === null) {
      return false;
    }
    
    // Check for valid header name format (RFC 7230)
    const headerNameRegex = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;
    if (!headerNameRegex.test(key)) {
      return false;
    }
    
    // Check value length (reasonable limit)
    const valueStr = String(value);
    if (valueStr.length > 8192) { // 8KB limit
      return false;
    }
    
    return true;
  }

  /**
   * Checks if header is restricted and should not be forwarded
   * @param {string} key - Header name
   * @returns {boolean} - True if restricted
   */
  isRestrictedHeader(key) {
    const restrictedHeaders = new Set([
      'host',
      'connection',
      'upgrade',
      'proxy-connection',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'content-encoding', // Let client handle
      'content-length'    // We calculate this
    ]);
    
    return restrictedHeaders.has(key.toLowerCase());
  }

  /**
   * Gets standard HTTP status text
   * @param {number} status - HTTP status code
   * @returns {string} - Status text
   */
  getStatusText(status) {
    const statusTexts = {
      100: 'Continue',
      101: 'Switching Protocols',
      200: 'OK',
      201: 'Created',
      202: 'Accepted',
      204: 'No Content',
      206: 'Partial Content',
      301: 'Moved Permanently',
      302: 'Found',
      304: 'Not Modified',
      307: 'Temporary Redirect',
      308: 'Permanent Redirect',
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      405: 'Method Not Allowed',
      409: 'Conflict',
      413: 'Payload Too Large',
      422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout'
    };
    
    return statusTexts[status] || 'Unknown Status';
  }

  /**
   * Creates error response for building failures
   * @param {Error} error - Error that occurred
   * @returns {Response} - Error response
   */
  createErrorResponse(error) {
    let status = 502; // Bad Gateway
    let message = 'Failed to process tunnel response';
    
    // Determine appropriate error status
    if (error.message.includes('too large')) {
      status = 413; // Payload Too Large
      message = 'Response too large';
    } else if (error.message.includes('Invalid') || error.message.includes('decode')) {
      status = 502; // Bad Gateway
      message = 'Invalid response from tunnel';
    } else if (error.message.includes('timeout')) {
      status = 504; // Gateway Timeout
      message = 'Tunnel response timeout';
    }
    
    const headers = new Headers();
    headers.set('Content-Type', 'text/plain');
    headers.set('X-Tunnel-Error', 'true');
    
    // Add default headers
    for (const [key, value] of Object.entries(this.defaultHeaders)) {
      headers.set(key, value);
    }
    
    // Add CORS headers
    for (const [key, value] of Object.entries(this.getCORSHeaders())) {
      headers.set(key, value);
    }
    
    return new Response(message, {
      status: status,
      statusText: this.getStatusText(status),
      headers: headers
    });
  }

  /**
   * Gets statistics about response processing
   * @returns {object} - Response builder statistics
   */
  getStats() {
    return {
      max_response_size: this.maxResponseSize,
      default_headers: Object.keys(this.defaultHeaders).length,
      features: {
        has_buffer: this.hasBuffer,
        has_atob: this.hasAtob,
        raw_binary_only: true
      }
    };
  }

  /**
   * Updates configuration safely
   * @param {object} config - New configuration
   */
  updateConfig(config = {}) {
    if (config.maxResponseSize && typeof config.maxResponseSize === 'number' && config.maxResponseSize > 0) {
      this.maxResponseSize = Math.min(config.maxResponseSize, 100 * 1024 * 1024); // 100MB max
    }
    
    if (config.defaultHeaders && typeof config.defaultHeaders === 'object') {
      // Validate new default headers
      const validHeaders = {};
      for (const [key, value] of Object.entries(config.defaultHeaders)) {
        if (this.isValidHeader(key, value)) {
          validHeaders[key] = value;
        }
      }
      this.defaultHeaders = { ...this.defaultHeaders, ...validHeaders };
    }
  }

  /**
   * Get CORS headers
   * @returns {object} - CORS headers
   */
  getCORSHeaders() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
  }
}