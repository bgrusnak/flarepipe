# FlarePipe Client

HTTP tunnel client for exposing local servers through Cloudflare Workers. Allows you to make your local development servers accessible from the internet via a public URL.

## Installation

```bash
npm install -g fast-tunnel-client
```

Or run directly with npx:
```bash
npx fast-tunnel-client --host myhost.myname.workers.dev --forward 3000:/api
```

## Usage

### Basic Usage

```bash
ft --host myhost.myname.workers.dev --auth secret123 --forward 3000:/api
```

This will forward all requests from `https://myhost.myname.workers.dev/api/*` to `http://localhost:3000/api/*`

### With API Prefix

```bash
ft --host myhost.myname.workers.dev --auth secret123 --prefix tunnel --forward 3000:/api
```

This uses server API endpoints like `/tunnel/register` instead of `/register` to avoid conflicts with your application routes.

### Multiple Port Forwarding

```bash
ft --host myhost.myname.workers.dev --auth secret123 \
   --forward 3000:/api \
   --forward 8080:/admin \
   --forward 5000:/websocket
```

### Root Path Forwarding

```bash
ft --host myhost.myname.workers.dev --auth secret123 --forward 3000
```

This forwards all requests from `https://myhost.myname.workers.dev/*` to `http://localhost:3000/*`

### Using Configuration File

```bash
ft --config tunnel.yaml
```

### Advanced Options

```bash
ft --host myhost.myname.workers.dev --auth secret123 \
   --forward 3000:/api \
   --forward 8080 \
   --prefix tunnel \
   --concurrency 32 \
   --local-host 127.0.0.1 \
   --open
```

## Command Line Options

| Option | Alias | Description | Required |
|--------|-------|-------------|----------|
| `--host` | `-h` | Upstream server providing forwarding | ✅ |
| `--auth` | `-a` | Authentication key for server access | ✅ |
| `--forward` | `-f` | Port forwarding rule: `PORT:PATH` or `PORT` for root | ✅ |
| `--concurrency` | `-c` | Max concurrent requests (default: 16) | ❌ |
| `--local-host` | `-l` | Tunnel traffic to this host instead of localhost | ❌ |
| `--prefix` | `-p` | API prefix path on server (default: empty) | ❌ |
| `--config` |  | Load configuration from YAML file | ❌ |
| `--open` | `-o` | Opens the tunnel URL in your browser | ❌ |
| `--help` |  | Show help and exit | ❌ |
| `--version` |  | Show version number | ❌ |

## Forward Rule Examples

- `--forward 3000` - Forward root path to port 3000
- `--forward 3000:/api` - Forward `/api/*` to port 3000
- `--forward 8080:/admin` - Forward `/admin/*` to port 8080
- `--forward 5000:/websocket` - Forward `/websocket/*` to port 5000

You can specify multiple `--forward` rules to handle different paths.

## API Prefix

The `--prefix` option allows you to specify a custom path prefix for server API endpoints. This is useful when your server routes might conflict with the tunnel's internal API routes.

### How Prefix Works

- **Without prefix** (default): Server API endpoints are at `/register`, `/poll`, etc.
- **With prefix**: Server API endpoints are at `/{prefix}/register`, `/{prefix}/poll`, etc.

### Examples

```bash
# No prefix (default)
ft --host worker.dev --auth key123 --forward 3000
# Server uses: /register, /poll, /response

# With prefix
ft --host worker.dev --auth key123 --prefix tunnel --forward 3000  
# Server uses: /tunnel/register, /tunnel/poll, /tunnel/response

# Nested prefix
ft --host worker.dev --auth key123 --prefix api/v1 --forward 3000
# Server uses: /api/v1/register, /api/v1/poll, /api/v1/response
```

### When to Use Prefix

Use a prefix when:
- Your application has routes that conflict with `/register`, `/poll`, `/response`
- You want to organize API endpoints under a specific path
- You're running multiple tunnel services on the same server

## Configuration File

You can use a YAML configuration file to specify all settings. CLI arguments will override config file values.

### Example config.yaml

```yaml
host: myhost.myname.workers.dev
auth: secret-key-123
prefix: tunnel
forward:
  - "3000:/api"
  - "8080:/admin"
  - 5000  # Root path forwarding
concurrency: 32
localHost: 127.0.0.1
open: true
```

### Using Config File

```bash
# Use config file only
ft --config config.yaml

# Override specific settings
ft --config config.yaml --concurrency 64 --open

# CLI args take priority over config file
ft --config config.yaml --auth different-key --prefix api --forward 9000:/test
```

### Priority Order

Settings are applied in this order (highest to lowest priority):
1. Command line arguments
2. Configuration file values  
3. Default values

## How It Works

1. **Registration**: Client connects to your Cloudflare Worker
2. **Polling**: Client continuously polls for incoming HTTP requests
3. **Processing**: When a request arrives, client forwards it to the appropriate local port
4. **Response**: Client sends the response back through the tunnel
5. **Concurrency**: Up to 16 requests can be processed simultaneously (configurable)

## Examples

### Single Service

Expose a React development server:
```bash
ft --host myhost.myname.workers.dev --auth secret123 --forward 3000 --open
```

### Microservices Setup

Expose multiple services with different paths:
```bash
ft --host myhost.myname.workers.dev --auth secret123 \
   --forward 3000:/api \
   --forward 3001:/auth \
   --forward 3002:/files \
   --forward 8080:/admin
```

### High Traffic Setup

Increase concurrency for high-traffic applications:
```bash
ft --host myhost.myname.workers.dev --auth secret123 \
   --forward 3000:/api \
   --concurrency 64
```

### With API Prefix

When your app routes conflict with tunnel endpoints:
```bash
ft --host myhost.myname.workers.dev --auth secret123 \
   --prefix tunnel \
   --forward 3000:/api \
   --forward 8080:/admin
```

### Using Configuration File

For complex setups, use a config file:
```bash
# Create config.yaml
cat > config.yaml << EOF
host: myhost.myname.workers.dev
auth: secret-key-123
prefix: tunnel
forward:
  - "3000:/api"
  - "8080:/admin"
  - "5000:/websocket"
  - 9000  # Root catch-all
concurrency: 32
localHost: 127.0.0.1
open: true
EOF

# Run with config
ft --config config.yaml
```

## Troubleshooting

### Connection Issues
- Ensure your Cloudflare Worker is deployed and accessible
- Verify the auth key is correct and matches server configuration
- Check that local services are running on specified ports
- Verify firewall settings allow outbound HTTPS connections

### Authentication Issues
- Double-check the auth key matches what's configured on the server
- Ensure the auth key is at least 8 characters and contains only valid characters
- Try regenerating the auth key if connection fails

### Prefix Issues
- Verify the prefix matches what's configured on the server
- Ensure prefix doesn't start or end with slashes (use `tunnel`, not `/tunnel/`)
- Check that prefix doesn't conflict with your application routes

### Performance Issues
- Increase `--concurrency` for applications with many simultaneous requests
- Monitor local service performance - the tunnel is only as fast as your local server
- Check network latency to Cloudflare edge locations

### Configuration Issues
- Validate YAML syntax if using config files
- Check that file paths in `--config` are correct
- Remember that CLI arguments override config file values

### Path Routing Issues
- Order matters: more specific paths should be defined first
- Use `--forward 3000` (root) as a catch-all after specific paths
- Test routing with simple HTTP requests using curl or browser dev tools

## Requirements

- Node.js 16.0.0 or higher
- Active internet connection
- Local HTTP services to tunnel

## License

MIT 