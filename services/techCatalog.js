'use strict';

/**
 * DevNexus Comprehensive Technology Catalog & Skill Matching Metadata
 * Single source of truth for onboarding categories, chip colors, and GitHub matching aliases.
 */

const TECH_CATEGORIES = [
  {
    id: 'programming-languages',
    name: 'Programming Languages',
    description: 'Core languages for systems, web, scripting, and application development',
    technologies: [
      { name: 'JavaScript', color: '#f1e05a', aliases: ['javascript', 'js', 'ecmascript'] },
      { name: 'TypeScript', color: '#3178c6', aliases: ['typescript', 'ts'] },
      { name: 'Python', color: '#3572A5', aliases: ['python', 'py'] },
      { name: 'Java', color: '#b07219', aliases: ['java'] },
      { name: 'C++', color: '#f34b7d', aliases: ['c++', 'cpp'] },
      { name: 'C#', color: '#178600', aliases: ['c#', 'csharp', 'dotnet'] },
      { name: 'C', color: '#555555', aliases: ['c'] },
      { name: 'Go', color: '#00ADD8', aliases: ['go', 'golang'] },
      { name: 'Rust', color: '#dea584', aliases: ['rust', 'rustlang'] },
      { name: 'Ruby', color: '#701516', aliases: ['ruby', 'rb'] },
      { name: 'PHP', color: '#4F5D95', aliases: ['php'] },
      { name: 'Swift', color: '#F05138', aliases: ['swift'] },
      { name: 'Kotlin', color: '#A97BFF', aliases: ['kotlin', 'kt'] },
      { name: 'Dart', color: '#00B4AB', aliases: ['dart'] },
      { name: 'Scala', color: '#c22d40', aliases: ['scala'] },
      { name: 'R', color: '#198CE7', aliases: ['r', 'rlang'] },
      { name: 'Elixir', color: '#6e4a7e', aliases: ['elixir'] },
      { name: 'Haskell', color: '#5e5086', aliases: ['haskell'] },
      { name: 'Lua', color: '#000080', aliases: ['lua'] },
      { name: 'Shell / Bash', color: '#89e051', aliases: ['shell', 'bash', 'sh', 'zsh'] }
    ]
  },
  {
    id: 'frontend-development',
    name: 'Frontend Development',
    description: 'UI frameworks, styling systems, and modern web build tools',
    technologies: [
      { name: 'React', color: '#61dafb', aliases: ['react', 'react.js', 'reactjs'] },
      { name: 'Next.js', color: '#a5b4fc', aliases: ['next.js', 'nextjs', 'next'] },
      { name: 'Vue.js', color: '#41b883', aliases: ['vue', 'vue.js', 'vuejs'] },
      { name: 'Nuxt.js', color: '#00DC82', aliases: ['nuxt', 'nuxt.js', 'nuxtjs'] },
      { name: 'Angular', color: '#dd0031', aliases: ['angular', 'angularjs'] },
      { name: 'Svelte', color: '#ff3e00', aliases: ['svelte', 'sveltekit'] },
      { name: 'HTML5', color: '#e34c26', aliases: ['html', 'html5'] },
      { name: 'CSS3', color: '#563d7c', aliases: ['css', 'css3'] },
      { name: 'Tailwind CSS', color: '#38bdf8', aliases: ['tailwind', 'tailwindcss', 'tailwind css'] },
      { name: 'Sass / SCSS', color: '#c6538c', aliases: ['sass', 'scss'] },
      { name: 'Redux', color: '#764abc', aliases: ['redux'] },
      { name: 'Vite', color: '#646cff', aliases: ['vite', 'vitejs'] },
      { name: 'Webpack', color: '#8dd6f9', aliases: ['webpack'] },
      { name: 'WebAssembly', color: '#654ff0', aliases: ['webassembly', 'wasm'] },
      { name: 'Astro', color: '#ff5d01', aliases: ['astro'] }
    ]
  },
  {
    id: 'backend-development',
    name: 'Backend Development',
    description: 'Server runtimes, web frameworks, and API architectures',
    technologies: [
      { name: 'Node.js', color: '#339933', aliases: ['node', 'node.js', 'nodejs'] },
      { name: 'Express.js', color: '#94a3b8', aliases: ['express', 'express.js', 'expressjs'] },
      { name: 'NestJS', color: '#e0234e', aliases: ['nestjs', 'nest'] },
      { name: 'Django', color: '#092e20', aliases: ['django'] },
      { name: 'Flask', color: '#cbd5e1', aliases: ['flask'] },
      { name: 'FastAPI', color: '#009688', aliases: ['fastapi'] },
      { name: 'Spring Boot', color: '#6db33f', aliases: ['spring', 'spring boot', 'springboot'] },
      { name: 'Ruby on Rails', color: '#cc0000', aliases: ['rails', 'ruby on rails'] },
      { name: 'Laravel', color: '#ff2d20', aliases: ['laravel'] },
      { name: 'ASP.NET Core', color: '#512bd4', aliases: ['asp.net', 'aspnet', 'dotnet', '.net'] },
      { name: 'Gin', color: '#00add8', aliases: ['gin'] },
      { name: 'GraphQL', color: '#e10098', aliases: ['graphql'] },
      { name: 'REST APIs', color: '#6366f1', aliases: ['rest', 'rest api', 'restful'] },
      { name: 'gRPC', color: '#244c5a', aliases: ['grpc'] },
      { name: 'Microservices', color: '#818cf8', aliases: ['microservices'] }
    ]
  },
  {
    id: 'mobile-development',
    name: 'Mobile Development',
    description: 'Cross-platform and native iOS / Android frameworks',
    technologies: [
      { name: 'React Native', color: '#61dafb', aliases: ['react native', 'react-native'] },
      { name: 'Flutter', color: '#02569B', aliases: ['flutter'] },
      { name: 'Android (Kotlin/Java)', color: '#3DDC84', aliases: ['android', 'kotlin', 'java'] },
      { name: 'iOS (Swift/SwiftUI)', color: '#F05138', aliases: ['ios', 'swift', 'swiftui'] },
      { name: 'Expo', color: '#a5b4fc', aliases: ['expo'] },
      { name: 'Ionic', color: '#3880ff', aliases: ['ionic'] },
      { name: 'Capacitor', color: '#119eff', aliases: ['capacitor'] },
      { name: 'Jetpack Compose', color: '#4285f4', aliases: ['jetpack compose', 'compose'] },
      { name: '.NET MAUI', color: '#512bd4', aliases: ['maui', '.net maui', 'xamarin'] }
    ]
  },
  {
    id: 'databases',
    name: 'Databases',
    description: 'Relational, NoSQL, caching, search engines, and ORMs',
    technologies: [
      { name: 'PostgreSQL', color: '#336791', aliases: ['postgresql', 'postgres'] },
      { name: 'MySQL', color: '#4479A1', aliases: ['mysql'] },
      { name: 'SQLite', color: '#003B57', aliases: ['sqlite'] },
      { name: 'MongoDB', color: '#47A248', aliases: ['mongodb', 'mongo'] },
      { name: 'Redis', color: '#DC382D', aliases: ['redis'] },
      { name: 'MariaDB', color: '#003545', aliases: ['mariadb'] },
      { name: 'Microsoft SQL Server', color: '#CC2927', aliases: ['sql server', 'mssql'] },
      { name: 'Oracle DB', color: '#F80000', aliases: ['oracle'] },
      { name: 'Firebase Firestore', color: '#FFCA28', aliases: ['firebase', 'firestore'] },
      { name: 'Supabase', color: '#3ECF8E', aliases: ['supabase'] },
      { name: 'Cassandra', color: '#1287B1', aliases: ['cassandra'] },
      { name: 'Elasticsearch', color: '#005571', aliases: ['elasticsearch', 'elastic'] },
      { name: 'DynamoDB', color: '#4053D6', aliases: ['dynamodb'] },
      { name: 'Prisma', color: '#5a67d8', aliases: ['prisma'] }
    ]
  },
  {
    id: 'ai-ml',
    name: 'AI & Machine Learning',
    description: 'Deep learning, data science, computer vision, and LLM tooling',
    technologies: [
      { name: 'TensorFlow', color: '#FF6F00', aliases: ['tensorflow', 'tf'] },
      { name: 'PyTorch', color: '#EE4C2C', aliases: ['pytorch', 'torch'] },
      { name: 'Scikit-learn', color: '#F7931E', aliases: ['scikit-learn', 'sklearn'] },
      { name: 'Keras', color: '#D00000', aliases: ['keras'] },
      { name: 'Hugging Face', color: '#FFD21E', aliases: ['huggingface', 'hugging face', 'transformers'] },
      { name: 'LangChain', color: '#1C3C3C', aliases: ['langchain'] },
      { name: 'OpenAI API', color: '#10a37f', aliases: ['openai'] },
      { name: 'Pandas', color: '#150458', aliases: ['pandas'] },
      { name: 'NumPy', color: '#013243', aliases: ['numpy'] },
      { name: 'OpenCV', color: '#5C3EE8', aliases: ['opencv'] },
      { name: 'Computer Vision', color: '#7c3aed', aliases: ['computer vision', 'cv'] },
      { name: 'NLP', color: '#8b5cf6', aliases: ['nlp', 'natural language processing'] },
      { name: 'LLMs', color: '#6366f1', aliases: ['llm', 'llms'] },
      { name: 'RAG', color: '#a855f7', aliases: ['rag'] },
      { name: 'Jupyter', color: '#F37626', aliases: ['jupyter', 'jupyter notebook'] }
    ]
  },
  {
    id: 'cloud-devops',
    name: 'Cloud & DevOps',
    description: 'Containers, orchestration, cloud providers, IaC, and observability',
    technologies: [
      { name: 'Docker', color: '#2496ED', aliases: ['docker', 'dockerfile'] },
      { name: 'Kubernetes', color: '#326CE5', aliases: ['kubernetes', 'k8s'] },
      { name: 'AWS', color: '#FF9900', aliases: ['aws', 'amazon web services'] },
      { name: 'Google Cloud (GCP)', color: '#4285F4', aliases: ['gcp', 'google cloud'] },
      { name: 'Microsoft Azure', color: '#0078D4', aliases: ['azure'] },
      { name: 'Git', color: '#F05032', aliases: ['git'] },
      { name: 'GitHub Actions', color: '#2088FF', aliases: ['github actions', 'workflows'] },
      { name: 'CI/CD', color: '#6366f1', aliases: ['ci/cd', 'ci', 'cd'] },
      { name: 'Terraform', color: '#7B42BC', aliases: ['terraform', 'hcl'] },
      { name: 'Ansible', color: '#EE0000', aliases: ['ansible'] },
      { name: 'Jenkins', color: '#D24939', aliases: ['jenkins'] },
      { name: 'Linux', color: '#FCC624', aliases: ['linux', 'ubuntu', 'debian'] },
      { name: 'Nginx', color: '#009639', aliases: ['nginx'] },
      { name: 'Prometheus', color: '#E6522C', aliases: ['prometheus'] },
      { name: 'Grafana', color: '#F46800', aliases: ['grafana'] },
      { name: 'Helm', color: '#0F1689', aliases: ['helm'] }
    ]
  },
  {
    id: 'ui-ux-design',
    name: 'UI/UX Design',
    description: 'Interface design, design systems, prototyping, and accessibility',
    technologies: [
      { name: 'Figma', color: '#F24E1E', aliases: ['figma'] },
      { name: 'Adobe XD', color: '#FF61F6', aliases: ['adobe xd', 'xd'] },
      { name: 'Sketch', color: '#F7B500', aliases: ['sketch'] },
      { name: 'Design Systems', color: '#a78bfa', aliases: ['design system', 'design systems'] },
      { name: 'Wireframing', color: '#818cf8', aliases: ['wireframing', 'wireframes'] },
      { name: 'Prototyping', color: '#c084fc', aliases: ['prototyping', 'prototype'] },
      { name: 'Accessibility (a11y)', color: '#38bdf8', aliases: ['a11y', 'accessibility', 'wcag'] },
      { name: 'Responsive Design', color: '#2dd4bf', aliases: ['responsive', 'responsive design'] },
      { name: 'CSS Grid & Flexbox', color: '#60a5fa', aliases: ['flexbox', 'css grid'] },
      { name: 'Storybook', color: '#FF4785', aliases: ['storybook'] }
    ]
  },
  {
    id: 'testing-qa',
    name: 'Testing & QA',
    description: 'Unit, integration, end-to-end, and API testing tools',
    technologies: [
      { name: 'Jest', color: '#C21325', aliases: ['jest'] },
      { name: 'Pytest', color: '#0A9EDC', aliases: ['pytest'] },
      { name: 'Playwright', color: '#2EAD33', aliases: ['playwright'] },
      { name: 'Cypress', color: '#17202C', aliases: ['cypress'] },
      { name: 'Selenium', color: '#43B02A', aliases: ['selenium'] },
      { name: 'Vitest', color: '#6E9F18', aliases: ['vitest'] },
      { name: 'Mocha', color: '#8D6748', aliases: ['mocha'] },
      { name: 'JUnit', color: '#25A162', aliases: ['junit'] },
      { name: 'Postman', color: '#FF6C37', aliases: ['postman'] },
      { name: 'API Testing', color: '#fb923c', aliases: ['api testing'] },
      { name: 'Unit Testing', color: '#4ade80', aliases: ['unit test', 'unit testing'] },
      { name: 'E2E Testing', color: '#34d399', aliases: ['e2e', 'end-to-end'] },
      { name: 'Performance Testing', color: '#f59e0b', aliases: ['performance testing', 'k6', 'jmeter'] }
    ]
  },
  {
    id: 'cybersecurity',
    name: 'Cybersecurity',
    description: 'Application security, pentesting, auth protocols, and DevSecOps',
    technologies: [
      { name: 'OWASP', color: '#ef4444', aliases: ['owasp'] },
      { name: 'Penetration Testing', color: '#dc2626', aliases: ['pentest', 'penetration testing'] },
      { name: 'Network Security', color: '#f97316', aliases: ['network security'] },
      { name: 'Cryptography', color: '#eab308', aliases: ['cryptography', 'crypto', 'encryption'] },
      { name: 'OAuth / JWT', color: '#ec4899', aliases: ['oauth', 'jwt', 'oidc'] },
      { name: 'Auth & Identity', color: '#f43f5e', aliases: ['authentication', 'rbac', 'iam'] },
      { name: 'Vulnerability Scanning', color: '#fb7185', aliases: ['vulnerability', 'cve'] },
      { name: 'Kali Linux', color: '#557C94', aliases: ['kali', 'kali linux'] },
      { name: 'Burp Suite', color: '#FF6633', aliases: ['burp', 'burp suite'] },
      { name: 'AppSec', color: '#e11d48', aliases: ['appsec', 'security'] },
      { name: 'DevSecOps', color: '#be123c', aliases: ['devsecops'] }
    ]
  },
  {
    id: 'other-technologies',
    name: 'Other Technologies',
    description: 'Documentation, real-time protocols, emerging tech, and custom skills',
    technologies: [
      { name: 'Docs', color: '#8b949e', aliases: ['docs', 'documentation'] },
      { name: 'Markdown', color: '#64748b', aliases: ['markdown', 'md'] },
      { name: 'WebSockets', color: '#06b6d4', aliases: ['websockets', 'websocket', 'socket.io'] },
      { name: 'Blockchain / Web3', color: '#f59e0b', aliases: ['blockchain', 'web3', 'solidity'] },
      { name: 'IoT', color: '#14b8a6', aliases: ['iot', 'mqtt', 'arduino'] },
      { name: 'Unity', color: '#94a3b8', aliases: ['unity'] },
      { name: 'Godot', color: '#478CBF', aliases: ['godot'] },
      { name: 'Data Visualization', color: '#3b82f6', aliases: ['d3', 'chart.js', 'visualization'] },
      { name: 'Technical Writing', color: '#9ca3af', aliases: ['technical writing', 'readme'] },
      { name: 'Localization (i18n)', color: '#a78bfa', aliases: ['i18n', 'l10n', 'localization', 'translation'] }
    ]
  }
];

const SKILL_PALETTE = {};
const SKILL_ALIASES = {};
const ALL_TECHNOLOGY_NAMES = [];

for (const category of TECH_CATEGORIES) {
  for (const tech of category.technologies) {
    SKILL_PALETTE[tech.name] = tech.color;
    SKILL_PALETTE[tech.name.toLowerCase()] = tech.color;
    ALL_TECHNOLOGY_NAMES.push(tech.name);

    const key = tech.name.toLowerCase();
    const aliasList = Array.isArray(tech.aliases) && tech.aliases.length > 0
      ? tech.aliases.map(a => a.toLowerCase())
      : [key];
    if (!aliasList.includes(key)) {
      aliasList.unshift(key);
    }
    SKILL_ALIASES[key] = [...new Set(aliasList)];
  }
}

// Legacy shorthand aliases
SKILL_ALIASES.js = ['javascript', 'js'];
SKILL_ALIASES.ts = ['typescript', 'ts'];
SKILL_ALIASES.py = ['python', 'py'];
SKILL_ALIASES.node = ['node', 'node.js', 'nodejs'];
SKILL_ALIASES.cpp = ['cpp', 'c++'];
SKILL_ALIASES.csharp = ['csharp', 'c#'];
SKILL_ALIASES.golang = ['golang', 'go'];
SKILL_ALIASES.documentation = ['documentation', 'docs'];

function getSkillColor(skillName) {
  if (!skillName || typeof skillName !== 'string') return '#818cf8';
  const clean = skillName.trim();
  return SKILL_PALETTE[clean] || SKILL_PALETTE[clean.toLowerCase()] || '#818cf8';
}

module.exports = {
  TECH_CATEGORIES,
  SKILL_PALETTE,
  SKILL_ALIASES,
  ALL_TECHNOLOGY_NAMES,
  getSkillColor
};
