import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

class SurgeClient {
  constructor() {
    this.checkSurgeInstalled();
  }

  checkSurgeInstalled() {
    try {
      execSync('surge --version', { stdio: 'ignore' });
    } catch (error) {
      throw new Error('Surge is not installed. Please run: npm install -g surge');
    }
  }

  async login(email, password) {
    // Warn about security implications
    console.warn('Warning: Login credentials are being passed in plaintext. Consider using environment variables.');
    
    return new Promise((resolve, reject) => {
      const loginProcess = spawn('surge', ['login'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';
      let errorOutput = '';
      const timeout = setTimeout(() => {
        loginProcess.kill();
        reject(new Error('Login process timed out after 30 seconds'));
      }, 30000);

      loginProcess.stdout.on('data', (data) => {
        output += data.toString();
        
        if (output.includes('email:')) {
          loginProcess.stdin.write(email + '\n');
        } else if (output.includes('password:')) {
          loginProcess.stdin.write(password + '\n');
        }
      });

      loginProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      loginProcess.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve({ success: true, message: 'Successfully logged in' });
        } else {
          reject(new Error(`Login failed: ${errorOutput || output}`));
        }
      });

      loginProcess.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Login process error: ${error.message}`));
      });
    });
  }

  whoami() {
    try {
      const result = execSync('surge whoami', { encoding: 'utf8' });
      return result.trim();
    } catch (error) {
      return null;
    }
  }

  list() {
    try {
      const result = execSync('surge list', { encoding: 'utf8' });
      const lines = result.split('\n').filter(line => line.includes('.surge.sh'));
      
      return lines.map(line => {
        const parts = line.trim().split(/\s+/);
        const domain = parts[0];
        const timeAgo = parts.slice(1, -3).join(' ');
        
        return {
          domain,
          timeAgo,
          url: `https://${domain}`
        };
      });
    } catch (error) {
      throw new Error(`Failed to list projects: ${error.message}`);
    }
  }

  teardown(domain) {
    // Validate domain format to prevent command injection
    if (!domain || typeof domain !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(domain)) {
      throw new Error(`Invalid domain format: ${domain}`);
    }
    
    try {
      execSync(`surge teardown ${domain}`, { stdio: 'inherit' });
      return { success: true, message: `Successfully removed ${domain}` };
    } catch (error) {
      throw new Error(`Failed to teardown ${domain}: ${error.message}`);
    }
  }

  logout() {
    try {
      execSync('surge logout', { stdio: 'inherit' });
      return { success: true, message: 'Successfully logged out' };
    } catch (error) {
      throw new Error(`Failed to logout: ${error.message}`);
    }
  }
}

export default SurgeClient;