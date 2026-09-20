import fs from 'fs';
import path from 'path';
import SurgeClient from './client.js';
import SurgeDeployment from './deploy.js';
import DomainGenerator from './domain-generator.js';

class SurgeProjectManager {
  constructor(configPath = './surge-projects.json') {
    this.configPath = configPath;
    this.client = new SurgeClient();
    this.deployment = new SurgeDeployment();
    this.loadProjects();
  }

  loadProjects() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        this.projects = JSON.parse(data);
      } else {
        this.projects = {};
        this.saveProjects();
      }
    } catch (error) {
      this.projects = {};
    }
  }

  saveProjects() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.projects, null, 2));
  }

  async createProject(name, config = {}) {
    if (this.projects[name] && !config.overwrite) {
      throw new Error(`Project "${name}" already exists. Use overwrite: true to replace.`);
    }

    const domain = config.domain || 
                   (config.persistentUrl && this.projects[name]?.domain) ||
                   DomainGenerator.generateWithSuffix();

    const project = {
      name,
      domain,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      persistent: config.persistentUrl || false,
      metadata: config.metadata || {}
    };

    this.projects[name] = project;
    this.saveProjects();

    return project;
  }

  getProject(name) {
    return this.projects[name] || null;
  }

  getAllProjects() {
    return Object.values(this.projects);
  }

  async deployProject(name, projectPath, options = {}) {
    const project = this.getProject(name);
    
    if (!project && !options.createIfNotExists) {
      throw new Error(`Project "${name}" not found. Use createIfNotExists: true to create it.`);
    }

    if (!project) {
      await this.createProject(name, {
        persistentUrl: options.persistentUrl,
        metadata: options.metadata
      });
    }

    const deploymentProject = this.projects[name];
    const domain = deploymentProject.persistent ? deploymentProject.domain : 
                   (options.domain || DomainGenerator.generateWithSuffix());

    try {
      const result = await this.deployment.deploy(projectPath, domain, options);
      
      this.projects[name].lastDeployment = {
        timestamp: new Date().toISOString(),
        domain: result.domain || domain,
        url: result.url,
        success: true
      };
      
      if (!deploymentProject.persistent) {
        this.projects[name].domain = result.domain || domain;
      }
      
      this.projects[name].updatedAt = new Date().toISOString();
      this.saveProjects();

      return {
        ...result,
        project: this.projects[name]
      };
    } catch (error) {
      this.projects[name].lastDeployment = {
        timestamp: new Date().toISOString(),
        success: false,
        error: error.message
      };
      this.saveProjects();
      throw error;
    }
  }

  async removeProject(name, options = {}) {
    const project = this.getProject(name);
    
    if (!project) {
      throw new Error(`Project "${name}" not found.`);
    }

    if (options.teardownDomain && project.domain) {
      try {
        await this.client.teardown(project.domain);
      } catch (error) {
        console.error(`Failed to teardown domain ${project.domain}:`, error.message);
      }
    }

    delete this.projects[name];
    this.saveProjects();

    return { success: true, message: `Project "${name}" removed` };
  }

  async deployHtmlContent(name, htmlContent, options = {}) {
    const project = await this.createProject(name, {
      persistentUrl: options.persistentUrl,
      metadata: { type: 'html-content', ...options.metadata }
    });

    const tempDir = path.join('./temp-surge-deploy', name);
    
    const result = await this.deployment.deployFromHtml(
      htmlContent, 
      project.domain,
      tempDir
    );

    this.projects[name].lastDeployment = {
      timestamp: new Date().toISOString(),
      domain: result.domain,
      url: result.url,
      success: true
    };
    this.saveProjects();

    return {
      ...result,
      project: this.projects[name]
    };
  }

  exportProjects() {
    return JSON.stringify(this.projects, null, 2);
  }

  importProjects(projectsData, options = { merge: true }) {
    const importedProjects = typeof projectsData === 'string' ? 
                            JSON.parse(projectsData) : projectsData;

    if (options.merge) {
      this.projects = { ...this.projects, ...importedProjects };
    } else {
      this.projects = importedProjects;
    }

    this.saveProjects();
    return { 
      success: true, 
      projectCount: Object.keys(this.projects).length 
    };
  }
}

export default SurgeProjectManager;