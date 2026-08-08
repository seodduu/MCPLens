import { defineConfig } from 'vitepress'

const sidebar = [
  { text: 'Quick Start', link: '/quick-start' },
  {
    text: 'Guide',
    items: [
      { text: 'VS Code Extension', link: '/guide/vscode-extension' },
      { text: 'Claude Code', link: '/guide/claude-code' },
      { text: 'Codex', link: '/guide/codex' },
      { text: 'Gemini CLI', link: '/guide/gemini-cli' },
      { text: 'Reading Reports', link: '/guide/reading-reports' },
      { text: 'Dashboard', link: '/guide/dashboard' },
      { text: 'Global Actions', link: '/guide/global-actions' }
    ]
  },
  {
    text: 'Concepts',
    items: [{ text: 'How It Works', link: '/concepts/how-it-works' }]
  },
  {
    text: 'Reference',
    items: [
      { text: 'CLI', link: '/reference/cli' },
      { text: 'Configuration', link: '/reference/configuration' }
    ]
  },
  { text: 'FAQ', link: '/faq' }
]

export default defineConfig({
  title: 'MCP Lens',
  description:
    'Context accounting for MCP servers: definition token cost vs. real usage, per client.',
  base: '/MCPLens-V2/',
  appearance: 'dark',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/seodduu/MCPLens-V2' }],
    outline: 'deep'
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Quick Start', link: '/quick-start' },
          { text: 'Guide', link: '/guide/vscode-extension' },
          { text: 'Reference', link: '/reference/cli' }
        ],
        sidebar
      }
    },
    ko: {
      label: '한국어',
      lang: 'ko',
      link: '/ko/'
    }
  }
})
