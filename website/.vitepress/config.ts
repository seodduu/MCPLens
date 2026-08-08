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
    search: {
      provider: 'local',
      options: {
        locales: {
          ko: {
            translations: {
              button: {
                buttonText: '검색',
                buttonAriaLabel: '검색'
              },
              modal: {
                displayDetails: '상세 목록 표시',
                resetButtonTitle: '검색 초기화',
                backButtonTitle: '검색 닫기',
                noResultsText: '검색 결과 없음',
                footer: {
                  selectText: '선택',
                  selectKeyAriaLabel: '엔터',
                  navigateText: '이동',
                  navigateUpKeyAriaLabel: '위쪽 화살표',
                  navigateDownKeyAriaLabel: '아래쪽 화살표',
                  closeText: '닫기',
                  closeKeyAriaLabel: 'esc'
                }
              }
            }
          }
        }
      }
    },
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
      description:
        'MCP 서버의 컨텍스트 회계: 정의 토큰 비용과 실제 사용량을 클라이언트별로 대조한다.',
      themeConfig: {
        nav: [
          { text: '빠른 시작', link: '/ko/quick-start' },
          { text: '가이드', link: '/ko/guide/vscode-extension' },
          { text: '레퍼런스', link: '/ko/reference/cli' }
        ],
        sidebar: koSidebar,
        outline: { level: 'deep', label: '이 페이지 목차' },
        docFooter: {
          prev: '이전 페이지',
          next: '다음 페이지'
        },
        darkModeSwitchLabel: '테마',
        lightModeSwitchTitle: '라이트 모드로 전환',
        darkModeSwitchTitle: '다크 모드로 전환',
        returnToTopLabel: '맨 위로',
        langMenuLabel: '언어 변경',
        sidebarMenuLabel: '메뉴',
        lastUpdatedText: '최종 수정'
      }
    }
  }
})
