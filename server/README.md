# FlarePipe Server

Cloudflare Worker server for FlarePipe HTTP tunnel service. Provides secure HTTP tunneling through Cloudflare's edge network with high performance and global availability.

## Architecture

FlarePipe Server is built as a Cloudflare Worker that:
- Accepts tunnel registrations from clients
- Buffers incoming public HTTP requests in memory queues
- Provides long-polling endpoints for tunnel clients
- Routes responses back to original requesters
- Manages tunnel lifecycle and cleanup

### Components

- **Tunnel Manager** - Handles tunnel registration, routing, and cleanup
- **Request Queue** - Manages request buffering and long-polling
- **Response Builder** - Converts tunnel responses to HTTP responses
- **Main Handler** - Routes requests and handles authentication

## Installation & Deployment

### Prerequisites

- Cloudflare account with Workers enabled
- Node.js 18+ and npm
- Wrangler CLI installed globally

```bash
npm install -g wrangler
```

### Setup

1. **Clone and install dependencies:**
```bash
cd server
npm install
```

2. **Configure Wrangler:**
```bash
wrangler login
```

3. **Set environment variables:**

For development:
```bash
# Already configured in wrangler.toml
npm run dev
```

For production:
```bash
# Set required secrets
npm run secret:auth
# Enter your secure auth key when prompted

npm run secret:prefix  
# Enter your URL prefix (or empty string for no prefix)
```

4. **Deploy:**
```bash
# Deploy to production
npm run deploy

# Deploy to staging
npm run deploy:staging
```

## Configuration

### Environment Variables

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `AUTH_KEY` | Authentication key for tunnel clients | ✅ | `secure-random-key-123` |
| `PREFIX` | URL prefix for API endpoints | ❌ | `""` (empty) or `"tunnel"` |

### URL Structure

With empty PREFIX:
- `https://your-worker.workers.dev/register`
- `https://your-worker.workers.dev/poll`

With PREFIX="tunnel":
- `https://your-worker.workers.dev/tunnel/register` 
- `https://your-worker.workers.dev/tunnel/poll`

Public requests go to any other path:
- `https://your-worker.workers.dev/api/users` → tunneled to client

## API Endpoints

All API endpoints require `Authorization: Bearer <AUTH_KEY>` header.

### POST /{PREFIX}/register

Register a new tunnel.

**Request:**
```json
{
  "forward_rules": [
    {"port": 3000, "path": "/api"},
    {"port": 8080, "path": "/admin"}
  ],
  "client_info": {
    "version": "1.0.0",
    "concurrency": 16,
    "local_host": "localhost"
  }
}
```

**Response:**
```json
{
  "tunnel_id": "tunnel_abc123",
  "public_url": "https://your-worker.workers.dev",
  "rules_registered": 2,
  "expires_in": 600000
}
```

### POST /{PREFIX}/unregister

Unregister a tunnel.

**Request:**
```json
{
  "tunnel_id": "tunnel_abc123"
}
```

### GET /{PREFIX}/poll?tunnel_id=abc123

Long-polling endpoint for tunnel clients to receive requests.

**Response (when request available):**
```json
{
  "id": "req_xyz789",
  "method": "GET",
  "path": "/api/users",
  "query": "limit=10",
  "headers": {"user-agent": "..."},
  "body": "",
  "timestamp": 1640995200000
}
```

**Response (no requests):**
```
HTTP 204 No Content
```

### POST /{PREFIX}/response

Submit response for a tunneled request.

**Request:**
```json
{
  "request_id": "req_xyz789",
  "tunnel_id": "tunnel_abc123", 
  "status": 200,
  "headers": {"content-type": "application/json"},
  "body": "{\"users\": []}"
}
```

### POST /{PREFIX}/heartbeat

Keep tunnel alive.

**Request:**
```json
{
  "tunnel_id": "tunnel_abc123",
  "timestamp": 1640995200000
}
```

## Performance & Limits

### Cloudflare Worker Limits

- **CPU Time:** 50ms per request (can be extended with paid plans)
- **Memory:** 128MB per request
- **Request Size:** 100MB maximum
- **Response Size:** 50MB maximum (configured limit)

### FlarePipe Limits

- **Max tunnels:** Unlimited (memory permitting)
- **Queue size:** 100 requests per tunnel
- **Request timeout:** 30 seconds
- **Tunnel timeout:** 10 minutes without heartbeat
- **Binary content:** 10MB maximum

### Performance Characteristics

- **Latency:** ~50-200ms additional latency (varies by edge location)
- **Throughput:** Limited by origin server and CF Worker CPU time
- **Concurrency:** Up to 1000 concurrent requests per Worker instance
- **Global:** Deployed to 300+ Cloudflare edge locations

## Monitoring

### Built-in Endpoints

Access tunnel statistics (requires auth):

```bash
curl -H "Authorization: Bearer your-auth-key" \
  https://your-worker.workers.dev/tunnel/stats
```

### Cloudflare Dashboard

Monitor your Worker in the Cloudflare Dashboard:
- Request volume and errors
- CPU time usage
- Memory consumption  
- Geographic distribution

### Logging

View real-time logs:
```bash
npm run tail        # Production logs
npm run tail:dev    # Development logs
```

## Troubleshooting

### Common Issues

**"AUTH_KEY not configured"**
- Set the AUTH_KEY secret: `npm run secret:auth`
- Verify deployment: `wrangler secret list`

**"Tunnel not found" errors**
- Check tunnel registration succeeded
- Verify heartbeat is being sent every 60 seconds
- Check tunnel hasn't exceeded 10-minute timeout

**High latency**
- Check client geographic location vs Cloudflare edge
- Monitor origin server response times
- Consider increasing client concurrency

**Memory errors**
- Reduce max queue size in code
- Implement request size limits
- Monitor queue depths

### Performance Optimization

**For high traffic:**
1. Increase client concurrency (`--concurrency 64`)
2. Use multiple tunnels for load distribution
3. Optimize origin server response times
4. Enable compression on origin servers

**For global deployment:**
1. Deploy to multiple Cloudflare zones if needed
2. Use Cloudflare's geographic routing
3. Consider client-side load balancing

### Debugging

**Enable debug mode:**
```javascript
// In src/index.js, add:
const DEBUG = env.DEBUG === 'true';
if (DEBUG) console.log('Debug info:', requestData);
```

**Check tunnel status:**
```bash
# View active tunnels (add debug endpoint if needed)
curl -H "Authorization: Bearer your-auth-key" \
  https://your-worker.workers.dev/tunnel/debug/tunnels
```

## Security Considerations

### Authentication
- Use strong, randomly generated AUTH_KEY (32+ characters)
- Rotate AUTH_KEY regularly
- Never expose AUTH_KEY in client-side code

### Network Security
- All tunnel traffic is HTTPS encrypted
- Client authentication prevents unauthorized tunnel creation
- Request/response data is not logged or persisted

### Rate Limiting
- Cloudflare provides automatic DDoS protection
- Consider implementing application-level rate limiting
- Monitor for unusual traffic patterns

## Development

### Local Development

```bash
npm run dev
```

This starts Wrangler dev server with development configuration.

### Testing

```bash
# Test tunnel registration
curl -X POST -H "Authorization: Bearer dev-secret-key-123" \
  -H "Content-Type: application/json" \
  -d '{"forward_rules":[{"port":3000,"path":"/api"}],"client_info":{"version":"1.0.0"}}' \
  http://localhost:8787/register

# Test public request
curl http://localhost:8787/api/test
```

### Code Structure

```
src/
├── index.js              # Main request handler and routing
├── tunnel-manager.js     # Tunnel lifecycle management  
├── request-queue.js      # Request buffering and polling
└── utils/
    └── response-builder.js # HTTP response construction
```

## Deployment Environments

### Development
- Uses `wrangler dev` with local configuration
- AUTH_KEY and PREFIX set in wrangler.toml
- No secrets required

### Staging  
- Deployed to staging worker subdomain
- Uses staging secrets
- Safe for testing with production-like data

### Production
- Deployed to production worker subdomain
- Uses production secrets (set via `wrangler secret`)
- Monitoring and alerting enabled

## Support

### Resources
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Wrangler CLI Reference](https://developers.cloudflare.com/workers/wrangler/)
- [FlarePipe Client Documentation](../client/README.md)

### Getting Help
- Check Cloudflare Worker logs in dashboard
- Review client connection logs
- Verify AUTH_KEY and PREFIX configuration
- Test with minimal tunnel setup first

## License

MIT License - see LICENSE file for details.