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

const koSidebar = [
  { text: '빠른 시작', link: '/ko/quick-start' },
  {
    text: '가이드',
    items: [
      { text: 'VS Code 확장', link: '/ko/guide/vscode-extension' },
      { text: 'Claude Code', link: '/ko/guide/claude-code' },
      { text: 'Codex', link: '/ko/guide/codex' },
      { text: 'Gemini CLI', link: '/ko/guide/gemini-cli' },
      { text: '리포트 읽기', link: '/ko/guide/reading-reports' },
      { text: '대시보드', link: '/ko/guide/dashboard' },
      { text: '전역 조치', link: '/ko/guide/global-actions' }
    ]
  },
  {
    text: '개념',
    items: [{ text: '동작 원리', link: '/ko/concepts/how-it-works' }]
  },
  {
    text: '레퍼런스',
    items: [
      { text: 'CLI', link: '/ko/reference/cli' },
      { text: '설정', link: '/ko/reference/configuration' }
    ]
  },
  { text: 'FAQ', link: '/ko/faq' }
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
      link: '/ko/',
      themeConfig: {
        nav: [
          { text: '빠른 시작', link: '/ko/quick-start' },
          { text: '가이드', link: '/ko/guide/vscode-extension' },
          { text: '레퍼런스', link: '/ko/reference/cli' }
        ],
        sidebar: koSidebar
      }
    }
  }
})
