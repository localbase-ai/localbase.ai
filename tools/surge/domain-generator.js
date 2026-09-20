const adjectives = [
  'amazing', 'brave', 'calm', 'clever', 'cool', 'curious', 'daring', 'eager',
  'elegant', 'fancy', 'fierce', 'gentle', 'happy', 'jolly', 'keen', 'kind',
  'lively', 'mighty', 'nice', 'proud', 'quick', 'quiet', 'rapid', 'sharp',
  'silly', 'smart', 'swift', 'vivid', 'wise', 'witty', 'zealous', 'bright',
  'cheerful', 'creative', 'dynamic', 'energetic', 'friendly', 'graceful',
  'heroic', 'inspired', 'joyful', 'luminous', 'magical', 'noble', 'optimistic',
  'peaceful', 'radiant', 'serene', 'tranquil', 'upbeat', 'vibrant', 'wonderful'
];

const nouns = [
  'anchor', 'bear', 'bird', 'butterfly', 'cat', 'cloud', 'comet', 'deer',
  'dolphin', 'eagle', 'falcon', 'flower', 'forest', 'fox', 'galaxy', 'garden',
  'hawk', 'horizon', 'island', 'jaguar', 'koala', 'lighthouse', 'lion', 'moon',
  'mountain', 'ocean', 'owl', 'panda', 'phoenix', 'planet', 'python', 'rainbow',
  'river', 'shark', 'sky', 'star', 'sun', 'tiger', 'tree', 'universe',
  'valley', 'whale', 'wind', 'wolf', 'zebra', 'aurora', 'cascade', 'crystal',
  'diamond', 'ember', 'flame', 'glacier', 'harbor', 'meadow', 'nebula', 'oasis'
];

class DomainGenerator {
  static generateRandomDomain() {
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adjective}-${noun}`;
  }

  static generateMultipleDomains(count = 5) {
    const domains = new Set();
    const maxIterations = count * 10; // Prevent infinite loops
    let iterations = 0;
    
    while (domains.size < count && iterations < maxIterations) {
      domains.add(this.generateRandomDomain());
      iterations++;
    }
    
    return Array.from(domains);
  }

  static generateWithSuffix(suffix = '.surge.sh') {
    return `${this.generateRandomDomain()}${suffix}`;
  }

  static isValidDomain(domain) {
    const regex = /^[a-z0-9]+([-][a-z0-9]+)*$/;
    return regex.test(domain);
  }

  static sanitizeDomain(domain) {
    return domain
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/--+/g, '-')
      .replace(/^-|-$/g, '');
  }
}

export default DomainGenerator;