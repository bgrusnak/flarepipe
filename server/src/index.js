// src/index.js

import TunnelManager from './tunnel-manager.js';
import RequestQueue from './request-queue.js';
import ResponseBuilder from './utils/response-builder.js';

// Global storage (in-memory)
const activeTunnels = new Map();
const requestQueues = new Map(); 
const pendingResponses = new Map();

// Initialize managers
const tunnelManager = new TunnelManager(activeTunnels);
const requestQueue = new RequestQueue(requestQueues, pendingResponses);
const responseBuilder = new ResponseBuilder();

/**
 * Main worker entry point
 */
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error('Unhandled error:', error);
      return new Response('Internal Server Error', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }
};

/**
 * Main request handler with routing
 * @param {Request} request - Incoming request
 * @param {object} env - Environment variables
 * @param {object} ctx - Execution context
 */
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const prefix = env.PREFIX || '';
  const authKey = env.AUTH_KEY;
  
  if (!authKey) {
    console.error('AUTH_KEY not configured');
    return new Response('Server configuration error', { status: 500 });
  }

  // Build API path prefix
  const apiPrefix = prefix ? `/${prefix}` : '';
  
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return handleCORS();
  }

  // Route API endpoints (require auth)
  if (url.pathname.startsWith(apiPrefix + '/')) {
    const apiPath = url.pathname.substring(apiPrefix.length);
    
    switch (apiPath) {
      case '/register':
        return handleRegister(request, env);
        
      case '/unregister':
        return handleUnregister(request, env);
        
      case '/poll':
        return handlePoll(request, env);
        
      case '/response':
        return handleResponse(request, env);
        
      case '/heartbeat':
        return handleHeartbeat(request, env);
        
      default:
        return new Response('Not Found', { 
          status: 404,
          headers: addCORSHeaders({})
        });
    }
  }

  // Handle public requests (proxy to tunnels)
  return handlePublicRequest(request, env, ctx);
}

/**
 * Validates auth token from request
 * @param {Request} request - HTTP request
 * @param {string} expectedAuth - Expected auth key
 */
function validateAuth(request, expectedAuth) {
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader) {
    return false;
  }
  
  const token = authHeader.replace(/^Bearer\s+/, '');
  return token === expectedAuth;
}

/**
 * Handles tunnel registration
 */
async function handleRegister(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  try {
    const body = await request.json();
    const result = await tunnelManager.registerTunnel(body);
    
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Register error:', error.message); // Don't log full error object
    return new Response(JSON.stringify({ error: 'Registration failed' }), {
      status: 400,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Handles tunnel unregistration
 */
async function handleUnregister(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  try {
    const body = await request.json();
    await tunnelManager.unregisterTunnel(body.tunnel_id);
    
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Unregister error:', error.message);
    return new Response(JSON.stringify({ error: 'Unregistration failed' }), {
      status: 400,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Handles long-polling for tunnel clients
 */
async function handlePoll(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  const url = new URL(request.url);
  const tunnelId = url.searchParams.get('tunnel_id');
  
  if (!tunnelId) {
    return new Response('Missing tunnel_id parameter', { 
      status: 400,
      headers: addCORSHeaders({})
    });
  }

  // Check if tunnel exists
  if (!tunnelManager.isActive(tunnelId)) {
    return new Response('Tunnel not found', { 
      status: 404,
      headers: addCORSHeaders({})
    });
  }

  try {
    const requestData = await requestQueue.waitForRequest(tunnelId, 30000); // 30 second timeout
    
    if (!requestData) {
      // No request available, return 204
      return new Response(null, { 
        status: 204,
        headers: addCORSHeaders({})
      });
    }

    // Send ArrayBuffer directly as body + metadata in headers
    const headers = addCORSHeaders({
      'X-Request-ID': requestData.id,
      'X-Method': requestData.method,
      'X-Path': requestData.path,
      'X-Query': requestData.query || '',
      'X-Headers': JSON.stringify(requestData.headers || {}),
      'X-Timestamp': String(requestData.timestamp)
    });

    return new Response(requestData.body || new ArrayBuffer(0), {
      status: 200,
      headers: headers
    });
  } catch (error) {
    console.error('Poll error:', error.message);
    return new Response(JSON.stringify({ error: 'Polling failed' }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Handles response from tunnel client - RAW BINARY ArrayBuffer + metadata in headers
 */
async function handleResponse(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  try {
    // Extract metadata from headers
    const requestId = request.headers.get('X-Request-ID');
    const tunnelId = request.headers.get('X-Tunnel-ID');
    const responseStatus = request.headers.get('X-Response-Status');
    const responseHeadersJson = request.headers.get('X-Response-Headers');
    
    if (!requestId) {
      return new Response('Missing X-Request-ID header', { 
        status: 400,
        headers: addCORSHeaders({})
      });
    }

    // Parse response headers
    let responseHeaders = {};
    if (responseHeadersJson) {
      try {
        responseHeaders = JSON.parse(responseHeadersJson);
      } catch (parseError) {
        console.warn('Failed to parse response headers:', parseError.message);
      }
    }

    // Get RAW BINARY body as ArrayBuffer
    const body = await request.arrayBuffer();

    // Resolve request with ArrayBuffer response
    await requestQueue.resolveRequest(requestId, {
      status: parseInt(responseStatus, 10) || 200,
      headers: responseHeaders,
      body: body // ArrayBuffer - RAW BINARY
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Response error:', error.message);
    return new Response(JSON.stringify({ error: 'Response processing failed' }), {
      status: 400,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Handles heartbeat from tunnel client
 */
async function handleHeartbeat(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: addCORSHeaders({})
    });
  }

  if (!validateAuth(request, env.AUTH_KEY)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: addCORSHeaders({})
    });
  }

  try {
    const body = await request.json();
    const { tunnel_id } = body;
    
    if (!tunnel_id) {
      return new Response('Missing tunnel_id', { 
        status: 400,
        headers: addCORSHeaders({})
      });
    }

    tunnelManager.updateHeartbeat(tunnel_id);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Heartbeat error:', error.message);
    return new Response(JSON.stringify({ error: 'Heartbeat failed' }), {
      status: 400,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Handles public requests (proxy to tunnels)
 */
async function handlePublicRequest(request, env, ctx) {
    const url = new URL(request.url);  
    // Find matching tunnel by path
    const tunnel = await tunnelManager.findTunnelByPath(url.pathname); 
    
    if (!tunnel) {  
      return new Response('Not Found', { 
        status: 404,
        headers: addCORSHeaders({
          'Content-Type': 'text/plain'
        })
      });
    }
     
    try {
      // Convert request to data for tunneling 
      const requestData = await serializeRequest(request); 
      // Queue request and wait for response 
      const response = await requestQueue.queueRequest(tunnel.id, requestData, 30000); 
      
      // Build HTTP response from tunnel response with CORS
      const httpResponse = await responseBuilder.buildResponse(response);
      
      // Add CORS headers to tunnel response
      const corsHeaders = addCORSHeaders({});
      for (const [key, value] of Object.entries(corsHeaders)) {
        httpResponse.headers.set(key, value);
      }
      
      return httpResponse;
      
    } catch (error) {
      console.error('❌ Public request error:', error.message);
      console.error('❌ Error stack:', error.stack);
      
      if (error.message === 'Request timeout') {
        return new Response('Gateway Timeout', { 
          status: 504,
          headers: addCORSHeaders({
            'Content-Type': 'text/plain'
          })
        });
      }
      
      return new Response('Bad Gateway', { 
        status: 502,
        headers: addCORSHeaders({
          'Content-Type': 'text/plain'
        })
      });
    }
  }
/**
 * Serializes HTTP request for tunneling - ALL DATA AS RAW BINARY
 * @param {Request} request - HTTP request
 */
async function serializeRequest(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    throw new Error('Invalid URL');
  }
  
  // Collect headers
  const headers = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key] = value;
  }

  // Get body as RAW BINARY ArrayBuffer
  let body = new ArrayBuffer(0);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      const arrayBuffer = await request.arrayBuffer();
      if (arrayBuffer.byteLength > 10 * 1024 * 1024) { // 10MB limit
        throw new Error('Request body too large');
      }
      body = arrayBuffer;
    } catch (error) {
      if (error.message === 'Request body too large') {
        throw error;
      }
      // Ignore other body read errors, use empty ArrayBuffer
    }
  }

  return {
    id: crypto.randomUUID(),
    method: request.method,
    path: url.pathname,
    query: url.search.substring(1), // Remove leading '?'
    headers: headers,
    body: body, // ArrayBuffer - RAW BINARY
    timestamp: Date.now()
  };
}

/**
 * Handles CORS preflight requests
 */
function handleCORS() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    }
  });
}

/**
 * Adds CORS headers to response headers
 * @param {object} headers - Existing headers
 */
function addCORSHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}