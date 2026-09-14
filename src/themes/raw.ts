// Theme CSS as raw strings, for inlining into exported HTML.
// ponytail: only the active theme is embedded today; embed per-theme at
// export time if HTML exports start carrying non-default themes.
import github from './github.css?raw'
import night from './night.css?raw'
import newsprint from './newsprint.css?raw'
import pixyll from './pixyll.css?raw'

export const themeRaw: Record<string, string> = { github, night, newsprint, pixyll }
export const githubCss = github
