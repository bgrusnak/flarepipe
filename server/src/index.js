// server/src/index.js

// Import Durable Object classes
import { TunnelRegistry } from './durable-objects/tunnel-registry.js';
import { RequestQueue } from './durable-objects/request-queue.js';
import ResponseBuilder from './utils/response-builder.js';

// Export Durable Object classes for Cloudflare
export { TunnelRegistry, RequestQueue };

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
        
      case '/stats':
        return handleStats(request, env);
        
      case '/debug/tunnels':
        return handleDebugTunnels(request, env);
        
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
 * Get Durable Object instances
 */
function getTunnelRegistry(env) {
  // Use single global instance for all tunnels
  const id = env.TUNNEL_REGISTRY.idFromName('global');
  return env.TUNNEL_REGISTRY.get(id);
}

function getRequestQueue(env) {
  // Use single global instance for all requests
  const id = env.REQUEST_QUEUE.idFromName('global');
  return env.REQUEST_QUEUE.get(id);
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
    const tunnelRegistry = getTunnelRegistry(env);
    const response = await tunnelRegistry.fetch(new Request('https://dummy/register', {
      method: 'POST',
      body: await request.text(),
      headers: {
        'Content-Type': 'application/json'
      }
    }));

    // Add CORS headers to response
    const responseText = await response.text();
    return new Response(responseText, {
      status: response.status,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Register error:', error.message);
    return new Response(JSON.stringify({ error: 'Registration failed: ' + error.message }), {
      status: 500,
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
    const tunnelRegistry = getTunnelRegistry(env);
    const response = await tunnelRegistry.fetch(new Request('https://dummy/unregister', {
      method: 'POST',
      body: await request.text(),
      headers: {
        'Content-Type': 'application/json'
      }
    }));

    const responseText = await response.text();
    return new Response(responseText, {
      status: response.status,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Unregister error:', error.message);
    return new Response(JSON.stringify({ error: 'Unregistration failed: ' + error.message }), {
      status: 500,
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

  try {
    // Update polling activity in tunnel registry
    const tunnelRegistry = getTunnelRegistry(env);
    
    // Call updatePollingActivity method on the DO
    await tunnelRegistry.fetch(new Request('https://dummy/update-polling', {
      method: 'POST',
      body: JSON.stringify({ tunnel_id: tunnelId }),
      headers: { 'Content-Type': 'application/json' }
    }));

    // Poll for requests from request queue
    const requestQueue = getRequestQueue(env);
    const pollUrl = new URL('https://dummy/poll');
    pollUrl.searchParams.set('tunnel_id', tunnelId);
    pollUrl.searchParams.set('timeout', '30000');

    const response = await requestQueue.fetch(new Request(pollUrl.toString(), {
      method: 'GET'
    }));

    // Forward response with CORS headers
    if (response.status === 204) {
      return new Response(null, { 
        status: 204,
        headers: addCORSHeaders({})
      });
    }

    const responseBody = await response.arrayBuffer();
    const headers = addCORSHeaders({});
    
    // Copy response headers (metadata from DO)
    for (const [key, value] of response.headers.entries()) {
      if (key.startsWith('x-')) {
        headers[key] = value;
      }
    }

    return new Response(responseBody, {
      status: response.status,
      headers: headers
    });
  } catch (error) {
    console.error('Poll error:', error.message);
    return new Response(JSON.stringify({ error: 'Polling failed: ' + error.message }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Handles response from tunnel client
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
    const requestQueue = getRequestQueue(env);
    
    // Forward request to request queue
    const forwardRequest = new Request('https://dummy/response', {
      method: 'POST',
      body: await request.arrayBuffer(),
      headers: {
        'X-Request-ID': request.headers.get('X-Request-ID'),
        'X-Tunnel-ID': request.headers.get('X-Tunnel-ID'),
        'X-Response-Status': request.headers.get('X-Response-Status'),
        'X-Response-Headers': request.headers.get('X-Response-Headers'),
        'Content-Type': 'application/octet-stream'
      }
    });

    const response = await requestQueue.fetch(forwardRequest);
    const responseText = await response.text();
    
    return new Response(responseText, {
      status: response.status,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Response error:', error.message);
    return new Response(JSON.stringify({ error: 'Response processing failed: ' + error.message }), {
      status: 500,
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
    const tunnelRegistry = getTunnelRegistry(env);
    const response = await tunnelRegistry.fetch(new Request('https://dummy/heartbeat', {
      method: 'POST',
      body: await request.text(),
      headers: {
        'Content-Type': 'application/json'
      }
    }));

    const responseText = await response.text();
    return new Response(responseText, {
      status: response.status,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Heartbeat error:', error.message);
    return new Response(JSON.stringify({ error: 'Heartbeat failed: ' + error.message }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Handles stats endpoint for monitoring
 */
async function handleStats(request, env) {
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

  try {
    const tunnelRegistry = getTunnelRegistry(env);
    const requestQueue = getRequestQueue(env);
    
    const [tunnelResponse, queueResponse] = await Promise.all([
      tunnelRegistry.fetch(new Request('https://dummy/stats')),
      requestQueue.fetch(new Request('https://dummy/stats'))
    ]);

    const tunnelStats = await tunnelResponse.json();
    const queueStats = await queueResponse.json();
    
    const stats = {
      server: {
        uptime: Date.now(),
        version: '1.2.0',
        environment: env.ENVIRONMENT || 'unknown',
        durable_objects: true
      },
      tunnels: tunnelStats,
      queues: queueStats
    };

    return new Response(JSON.stringify(stats, null, 2), {
      status: 200,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Stats error:', error.message);
    return new Response(JSON.stringify({ error: 'Stats failed: ' + error.message }), {
      status: 500,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  }
}

/**
 * Handles debug tunnels endpoint
 */
async function handleDebugTunnels(request, env) {
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

  try {
    const tunnelRegistry = getTunnelRegistry(env);
    const requestQueue = getRequestQueue(env);
    
    const [tunnelsResponse, queuesResponse] = await Promise.all([
      tunnelRegistry.fetch(new Request('https://dummy/list-tunnels')),
      requestQueue.fetch(new Request('https://dummy/stats'))
    ]);
    
    const tunnels = await tunnelsResponse.json();
    const queueStats = await queuesResponse.json();
    
    const debug = {
      tunnels: tunnels,
      queues: {
        total_queued: queueStats.total_queued || 0,
        total_pending: queueStats.total_pending || 0,
        active_queues: queueStats.active_queues || 0
      },
      timestamp: Date.now(),
      durable_objects: true
    };

    return new Response(JSON.stringify(debug, null, 2), {
      status: 200,
      headers: addCORSHeaders({
        'Content-Type': 'application/json'
      })
    });
  } catch (error) {
    console.error('Debug tunnels error:', error.message);
    return new Response(JSON.stringify({ error: 'Debug failed: ' + error.message }), {
      status: 500,
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
  
  try {
    // Find matching tunnel
    const tunnelRegistry = getTunnelRegistry(env);
    const findUrl = new URL('https://dummy/find-tunnel');
    findUrl.searchParams.set('path', url.pathname);
    
    const tunnelResponse = await tunnelRegistry.fetch(new Request(findUrl.toString()));
    
    if (tunnelResponse.status === 404) {
      return new Response('Not Found', { 
        status: 404,
        headers: addCORSHeaders({
          'Content-Type': 'text/plain'
        })
      });
    }

    if (!tunnelResponse.ok) {
      throw new Error(`Tunnel lookup failed: ${tunnelResponse.status}`);
    }

    const tunnelInfo = await tunnelResponse.json();
    const { tunnel_id } = tunnelInfo;

    // Serialize request for tunneling
    const requestData = await serializeRequest(request);
    
    // Queue request and wait for response
    const requestQueue = getRequestQueue(env);
    const queueResponse = await requestQueue.fetch(new Request('https://dummy/queue', {
      method: 'POST',
      body: requestData.body,
      headers: {
        'X-Tunnel-ID': tunnel_id,
        'X-Request-ID': requestData.id,
        'X-Method': requestData.method,
        'X-Path': requestData.path,
        'X-Query': requestData.query,
        'X-Headers': JSON.stringify(requestData.headers),
        'X-Timeout': '30000',
        'Content-Type': 'application/octet-stream'
      }
    }));

    if (!queueResponse.ok) {
      const errorData = await queueResponse.text();
      let errorMessage = 'Queue request failed';
      try {
        const parsed = JSON.parse(errorData);
        errorMessage = parsed.error || errorMessage;
      } catch (e) {
        // Use default message
      }
      throw new Error(errorMessage);
    }

    // Extract response data from queue response
    const responseStatus = parseInt(queueResponse.headers.get('X-Response-Status') || '200', 10);
    const responseHeadersJson = queueResponse.headers.get('X-Response-Headers');
    const responseBody = await queueResponse.arrayBuffer();

    // Parse response headers
    let responseHeaders = {};
    if (responseHeadersJson) {
      try {
        responseHeaders = JSON.parse(responseHeadersJson);
      } catch (e) {
        console.warn('Failed to parse response headers:', e.message);
      }
    }

    // Build final response using ResponseBuilder
    const responseBuilder = new ResponseBuilder();
    const finalResponse = await responseBuilder.buildResponse({
      status: responseStatus,
      headers: responseHeaders,
      body: responseBody
    });

    return finalResponse;
    
  } catch (error) {
    console.error('❌ Public request error:', error.message);
    console.error('❌ Error stack:', error.stack);
    
    if (error.message.includes('timeout') || error.message.includes('Request timeout')) {
      return new Response('Gateway Timeout', { 
        status: 504,
        headers: addCORSHeaders({
          'Content-Type': 'text/plain'
        })
      });
    }
    
    if (error.message.includes('queue is full') || error.message.includes('overloaded')) {
      return new Response('Service Temporarily Unavailable', { 
        status: 503,
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
      console.warn('Failed to read request body:', error.message);
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