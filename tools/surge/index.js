import SurgeClient from './client.js';
import SurgeDeployment from './deploy.js';
import SurgeProjectManager from './project-manager.js';
import DomainGenerator from './domain-generator.js';

export {
  SurgeClient,
  SurgeDeployment,
  SurgeProjectManager,
  DomainGenerator
};

export const createClient = () => new SurgeClient();
export const createDeployment = () => new SurgeDeployment();
export const createProjectManager = (configPath) => new SurgeProjectManager(configPath);
export const generateDomain = () => DomainGenerator.generateRandomDomain();
export const generateDomainWithSuffix = () => DomainGenerator.generateWithSuffix();