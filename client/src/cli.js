// src/cli.js

const { Command } = require('commander');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const open = require('open');
const TunnelClient = require('./client');
const { validateHost, validateForwardRule, validateConcurrency, validateAuthKey, validatePrefix } = require('./utils/validator');

class CLI {
  constructor() {
    this.program = new Command();
    this.client = null;
    this.isShuttingDown = false;
    this.setupCommands();
    this.setupSignalHandlers();
  }

  /**
   * Sets up command line interface
   */
  setupCommands() {
    this.program
      .name('ft')
      .description('Fast Tunnel - HTTP tunnel client for exposing local servers')
      .version('1.0.0')
      .option('-h, --host <host>', 'Upstream server providing forwarding')
      .option('-a, --auth <key>', 'Authentication key for server access')
      .option('-f, --forward <rule>', 'Port forwarding rule: "PORT:PATH" or "PORT" for root', this.collectForwardRules, [])
      .option('-c, --concurrency <number>', 'Max concurrent requests (default: 16)', '16')
      .option('-l, --local-host <host>', 'Tunnel traffic to this host instead of localhost')
      .option('-p, --prefix <prefix>', 'API prefix path on server (default: empty)')
      .option('--config <file>', 'Load configuration from YAML file')
      .option('-o, --open', 'Opens the tunnel URL in your browser')
      .helpOption('--help', 'Show this help and exit')
      .addHelpText('after', `
Examples:
  ft --host myhost.myname.workers.dev --auth secret123 --forward 3000
  ft -h myhost.myname.workers.dev -a secret123 -f 3000:/api -f 8080:/admin
  ft --config tunnel.yaml --forward 3000 --open
  ft -h myhost.myname.workers.dev -a secret123 -f 3000 --prefix tunnel
  ft -h myhost.myname.workers.dev -a secret123 -f 3000 -l 127.0.0.1

Forward Rules:
  PORT        Forward root path (/) to PORT
  PORT:PATH   Forward PATH/* to PORT
  
  Examples:
    3000        All requests to localhost:3000
    3000:/api   Requests to /api/* go to localhost:3000
    8080:/admin Requests to /admin/* go to localhost:8080

Configuration File:
  Use --config to load settings from YAML file. CLI arguments override config file values.
  
  Example config.yaml:
    host: myhost.myname.workers.dev
    auth: secret-key-123
    prefix: tunnel
    forward:
      - "3000:/api"
      - "8080:/admin"
      - 5000
    concurrency: 32
    localHost: 127.0.0.1`);

    // Override default help to show Russian text for version
    this.program.configureOutput({
      writeErr: (str) => process.stderr.write(str),
      writeOut: (str) => {
        if (str.includes('display version number')) {
          str = str.replace('display version number', 'Показать номер версии');
        }
        process.stdout.write(str);
      }
    });
  }

  /**
   * Collects multiple forward rules
   * @param {string} value - Forward rule value
   * @param {Array} previous - Previous rules
   * @returns {Array} - Updated rules array
   */
  collectForwardRules(value, previous) {
    return previous.concat([value]);
  }

  /**
   * Loads and parses configuration from YAML file
   * @param {string} configPath - Path to config file
   * @returns {object} - Parsed configuration
   */
  loadConfigFile(configPath) {
    try {
      if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(configContent);
      
      if (!config || typeof config !== 'object') {
        throw new Error('Invalid YAML config file format');
      }

      // Normalize forward rules to array format
      if (config.forward) {
        if (!Array.isArray(config.forward)) {
          throw new Error('Config "forward" must be an array');
        }
        
        // Convert numbers to strings
        config.forward = config.forward.map(rule => {
          if (typeof rule === 'number') {
            return rule.toString();
          }
          return rule;
        });
      }

      return config;
    } catch (error) {
      throw new Error(`Failed to load config file: ${error.message}`);
    }
  }

  /**
   * Merges configuration from config file and CLI options
   * @param {object} cliOptions - CLI parsed options
   * @returns {object} - Merged configuration
   */
  mergeConfiguration(cliOptions) {
    let config = {};

    // Load config file if specified
    if (cliOptions.config) {
      const configPath = path.resolve(cliOptions.config);
      config = this.loadConfigFile(configPath);
    }

    // CLI options override config file (priority: CLI > config > defaults)
    const merged = {
      host: cliOptions.host || config.host,
      auth: cliOptions.auth || config.auth,
      forward: cliOptions.forward.length > 0 ? cliOptions.forward : (config.forward || []),
      concurrency: cliOptions.concurrency || config.concurrency || '16',
      localHost: cliOptions.localHost || config.localHost,
      prefix: cliOptions.prefix || config.prefix || '',
      open: cliOptions.open || config.open || false
    };

    return merged;
  }
  /**
   * Validates merged configuration
   * @param {object} config - Merged configuration
   * @param {boolean} hasConfigFile - Whether config file was used
   */
  validateOptions(config, hasConfigFile = false) {
    const errors = [];

    // Validate host
    if (!config.host) {
      if (hasConfigFile) {
        errors.push('Missing host in configuration. Add host to config file or use --host option.');
      } else {
        errors.push('Missing required option --host. Use --host <host> or --config <file>.');
      }
    } else if (!validateHost(config.host)) {
      errors.push('Invalid host format. Use domain name or IP address.');
    }

    // Validate auth key
    if (!config.auth) {
      if (hasConfigFile) {
        errors.push('Missing auth key in configuration. Add auth to config file or use --auth option.');
      } else {
        errors.push('Missing required option --auth. Use --auth <key> or --config <file>.');
      }
    } else if (!validateAuthKey(config.auth)) {
      errors.push('Invalid auth key. Must be 8-128 characters, alphanumeric with _, -, . allowed.');
    }

    // Validate forward rules
    if (!config.forward || config.forward.length === 0) {
      if (hasConfigFile) {
        errors.push('Missing forward rules in configuration. Add forward rules to config file or use --forward option.');
      } else {
        errors.push('Missing required forward rules. Use --forward PORT or --forward PORT:PATH, or --config <file>.');
      }
    } else {
      for (const rule of config.forward) {
        const parsed = validateForwardRule(rule);
        if (!parsed) {
          errors.push(`Invalid forward rule: "${rule}". Use PORT or PORT:PATH format.`);
        }
      }
    }

    // Validate concurrency
    if (!validateConcurrency(config.concurrency)) {
      errors.push('Concurrency must be a number between 1 and 1000.');
    }

    // Validate local host if provided
    if (config.localHost && !validateHost(config.localHost)) {
      errors.push('Invalid local host format. Use domain name or IP address.');
    }

    // Validate prefix if provided
    if (config.prefix && !validatePrefix(config.prefix)) {
      errors.push('Invalid prefix format. Use alphanumeric characters, dots, dashes. No leading/trailing slashes.');
    }

    if (errors.length > 0) {
      console.error('Configuration errors:');
      errors.forEach(error => console.error(`  • ${error}`));
      console.error('\nUse --help for usage information.');
      process.exit(1);
    }
  }

  /**
   * Sets up signal handlers for graceful shutdown
   */
  setupSignalHandlers() {
    const handleShutdown = async (signal) => {
      if (this.isShuttingDown) {
        console.log('\nForce exit...');
        process.exit(1);
      }

      this.isShuttingDown = true;
      console.log(`\nReceived ${signal}, shutting down gracefully...`);

      if (this.client) {
        try {
          await this.client.stop();
          console.log('Tunnel client stopped successfully');
        } catch (error) {
          console.error('Error during shutdown:', error.message);
        }
      }

      process.exit(0);
    };

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error.message);
      if (this.client) {
        this.client.stop().catch(() => {}).finally(() => process.exit(1));
      } else {
        process.exit(1);
      }
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled promise rejection:', reason);
      if (this.client) {
        this.client.stop().catch(() => {}).finally(() => process.exit(1));
      } else {
        process.exit(1);
      }
    });
  }

  /**
   * Opens tunnel URL in browser
   * @param {string} host - Tunnel host
   */
  async openInBrowser(host) {
    try {
      const url = host.startsWith('http') ? host : `https://${host}`;
      await open(url);
      console.log(`Opened ${url} in your default browser`);
    } catch (error) {
      console.warn('Failed to open browser:', error.message);
    }
  }

  /**
   * Displays startup banner
   * @param {object} config - Configuration object
   */
  displayBanner(config) {
    console.log('');
    console.log('🚀 FlarePipe Client');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📡 Tunnel Host: ${config.host}`);
    console.log(`🔑 Auth Key: ${config.auth.substring(0, 4)}***`);
    if (config.prefix) {
      console.log(`🔗 API Prefix: /${config.prefix}`);
    }
    console.log(`🎯 Forward Rules:`);
    
    config.forward.forEach(rule => {
      const parsed = validateForwardRule(rule);
      if (parsed) {
        if (parsed.path === '/') {
          console.log(`   • All requests → localhost:${parsed.port}`);
        } else {
          console.log(`   • ${parsed.path}/* → localhost:${parsed.port}`);
        }
      }
    });
    
    console.log(`⚡ Concurrency: ${config.concurrency} requests`);
    if (config.localHost) {
      console.log(`🏠 Local Host: ${config.localHost}`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
  }

  /**
   * Starts the tunnel client with configuration
   * @param {object} config - Merged configuration
   */
  async startClient(config) {
    try {
      // Create and configure client
      this.client = new TunnelClient({
        requestTimeout: 30000,
        maxRequestSize: 10 * 1024 * 1024, // 10MB
        retryAttempts: 3,
        enableCompression: true
      });

      // Configure from merged config
      const clientConfig = {
        host: config.host,
        auth: config.auth,
        prefix: config.prefix,
        forward: config.forward,
        concurrency: parseInt(config.concurrency, 10),
        localHost: config.localHost
      };

      this.client.configure(clientConfig);

      // Display banner
      this.displayBanner(config);

      // Start client
      console.log('Starting tunnel client...');
      await this.client.start();

      // Open browser if requested
      if (config.open) {
        await this.openInBrowser(config.host);
      }

      // Display success message
      console.log('✅ Tunnel is active and ready to receive requests');
      console.log('   Press Ctrl+C to stop the tunnel');
      console.log('');

      // Start status monitoring
      this.startStatusMonitoring();

    } catch (error) {
      console.error('❌ Failed to start tunnel client:');
      console.error(`   ${error.message}`);
      
      if (error.message.includes('ECONNREFUSED')) {
        console.error('');
        console.error('💡 Troubleshooting tips:');
        console.error('   • Check if the tunnel server is running');
        console.error('   • Verify the host URL is correct');
        console.error('   • Check your internet connection');
      } else if (error.message.includes('Registration failed')) {
        console.error('');
        console.error('💡 Troubleshooting tips:');
        console.error('   • Verify the host URL is correct');
        console.error('   • Check if the auth key is valid');
        console.error('   • Check if the server accepts new tunnels');
        console.error('   • Try again in a few moments');
      }
      
      process.exit(1);
    }
  }

  /**
   * Starts periodic status monitoring
   */
  startStatusMonitoring() {
    let lastRequestCount = 0;
    
    const displayStatus = () => {
      if (!this.client || !this.client.isRunning) {
        return;
      }

      const status = this.client.getStatus();
      const newRequests = status.stats.requestsProcessed - lastRequestCount;
      
      if (newRequests > 0) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[${timestamp}] Processed ${newRequests} requests (Total: ${status.stats.requestsProcessed}, Success: ${status.stats.successRate})`);
        lastRequestCount = status.stats.requestsProcessed;
      }
    };

    // Display status every 30 seconds if there's activity
    setInterval(displayStatus, 30000);
  }

  /**
   * Runs the CLI with provided arguments
   * @param {Array} argv - Command line arguments
   */
  async run(argv) {
    try {
      // Parse command line arguments
      this.program.parse(argv);
      const cliOptions = this.program.opts();

      // Merge configuration from CLI and config file
      const config = this.mergeConfiguration(cliOptions);

      // Validate merged configuration
      const hasConfigFile = !!cliOptions.config;
      this.validateOptions(config, hasConfigFile);

      // Start the client
      await this.startClient(config);

    } catch (error) {
      if (error.code === 'commander.missingMandatoryOptionValue' || 
          error.code === 'commander.missingRequiredArgument') {
        console.error('❌ Missing required options');
        console.error('');
        this.program.help();
      } else if (error.code === 'commander.unknownOption') {
        console.error(`❌ Unknown option: ${error.message.split("'")[1]}`);
        console.error('');
        this.program.help();
      } else {
        console.error('❌ Unexpected error:', error.message);
        process.exit(1);
      }
    }
  }
}

module.exports = CLI;