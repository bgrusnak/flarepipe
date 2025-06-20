// src/utils/response-builder.js

export default class ResponseBuilder {
    /**
     * Creates a new response builder
     */
    constructor() {
      this.maxResponseSize = 50 * 1024 * 1024; // 50MB limit for CF Worker
      this.maxBinarySize = 10 * 1024 * 1024; // 10MB limit for binary content
      this.defaultHeaders = {
        'X-Tunnel-Proxy': 'flarepipe-server/1.0.0'
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
        
        // Process body content
        const { processedBody, updatedHeaders } = await this.processBody(body, processedHeaders);
        
        // Create Response object
        const response = new Response(processedBody, {
          status: status,
          statusText: this.getStatusText(status),
          headers: updatedHeaders
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
  
      // Validate body size
      if (responseData.body && typeof responseData.body === 'string') {
        const estimatedSize = responseData.body.length;
        if (estimatedSize > this.maxResponseSize) {
          throw new Error(`Response too large: ${estimatedSize} bytes`);
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
      
      return processedHeaders;
    }
  
    /**
     * Processes response body content with immutable header handling
     * @param {string} body - Body content from tunnel client
     * @param {Headers} headers - Processed headers
     * @returns {object} - {processedBody, updatedHeaders}
     */
    async processBody(body, headers) {
      if (!body) {
        return { processedBody: '', updatedHeaders: headers };
      }
      
      // Create new Headers object to avoid mutation
      const updatedHeaders = new Headers(headers);
      
      // Check if content is base64 encoded (from binary data)
      const tunnelEncoding = headers.get('x-tunnel-encoding');
      
      if (tunnelEncoding === 'base64') {
        try {
          // Validate base64 before decode
          if (!this.isValidBase64(body)) {
            throw new Error('Invalid base64 content');
          }
          
          // Check size limit for binary content
          const estimatedBinarySize = (body.length * 3) / 4; // Approximate decoded size
          if (estimatedBinarySize > this.maxBinarySize) {
            throw new Error(`Binary content too large: ${estimatedBinarySize} bytes`);
          }
          
          // Decode base64 content
          const binaryData = this.decodeBase64Safe(body);
          
          // Remove the tunnel-specific header
          updatedHeaders.delete('x-tunnel-encoding');
          
          // Update content-length with actual size
          updatedHeaders.set('content-length', binaryData.length.toString());
          
          return { processedBody: binaryData, updatedHeaders };
          
        } catch (error) {
          console.error('Failed to decode base64 content:', error.message);
          // Return original content if decode fails
          updatedHeaders.delete('x-tunnel-encoding');
          return { processedBody: body, updatedHeaders };
        }
      }
      
      // Return text content as-is
      return { processedBody: body, updatedHeaders };
    }
  
    /**
     * Validates base64 string format
     * @param {string} str - String to validate
     * @returns {boolean} - True if valid base64
     */
    isValidBase64(str) {
      if (!str || typeof str !== 'string') {
        return false;
      }
      
      // Base64 regex pattern
      const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
      
      // Check format and length
      return base64Regex.test(str) && str.length % 4 === 0;
    }
  
    /**
     * Safely decodes base64 string to Uint8Array with fallbacks
     * @param {string} base64String - Base64 encoded string
     * @returns {Uint8Array} - Decoded binary data
     */
    decodeBase64Safe(base64String) {
      try {
        // Method 1: Use atob if available (most CF Workers)
        if (this.hasAtob) {
          const binaryString = atob(base64String);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          return bytes;
        }
        
        // Method 2: Use Buffer if available (Node.js compatibility)
        if (this.hasBuffer) {
          const buffer = Buffer.from(base64String, 'base64');
          return new Uint8Array(buffer);
        }
        
        // Method 3: Manual decode as fallback
        return this.manualBase64Decode(base64String);
        
      } catch (error) {
        throw new Error(`Base64 decode failed: ${error.message}`);
      }
    }
  
    /**
     * Manual base64 decoder as ultimate fallback
     * @param {string} base64 - Base64 string
     * @returns {Uint8Array} - Decoded bytes
     */
    manualBase64Decode(base64) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const lookup = {};
      
      // Create lookup table
      for (let i = 0; i < chars.length; i++) {
        lookup[chars[i]] = i;
      }
      
      const len = base64.length;
      const bytes = [];
      
      for (let i = 0; i < len; i += 4) {
        const a = lookup[base64[i]] || 0;
        const b = lookup[base64[i + 1]] || 0;
        const c = lookup[base64[i + 2]] || 0;
        const d = lookup[base64[i + 3]] || 0;
        
        const bitmap = (a << 18) | (b << 12) | (c << 6) | d;
        
        bytes.push((bitmap >> 16) & 255);
        if (base64[i + 2] !== '=') bytes.push((bitmap >> 8) & 255);
        if (base64[i + 3] !== '=') bytes.push(bitmap & 255);
      }
      
      return new Uint8Array(bytes);
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
        max_binary_size: this.maxBinarySize,
        default_headers: Object.keys(this.defaultHeaders).length,
        supported_encodings: ['base64', 'text'],
        features: {
          has_buffer: this.hasBuffer,
          has_atob: this.hasAtob,
          manual_decode: true
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
      
      if (config.maxBinarySize && typeof config.maxBinarySize === 'number' && config.maxBinarySize > 0) {
        this.maxBinarySize = Math.min(config.maxBinarySize, this.maxResponseSize);
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
  }