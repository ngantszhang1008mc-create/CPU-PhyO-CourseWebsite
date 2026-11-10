# CPU Physics Olympiad course website

## Public content boundary

The public build contains the classroom interface and the generic package authoring guide. Access private source folders only when the user explicitly names and authorizes them. This classroom uses an authorized Lesson 1 companion. Keep real source files, private packages, setup tokens and credentials outside Git, web/public and web/dist. Prepare authorized packages in private-drafts/. Release to students through the authenticated admin controls. Builds must not depend on private content.

## Architecture

Work in the Astro app under web/. Author course content in private TypeScript/React packages, then compile with npm run pack:lesson. The Worker validates uploads and gates all classroom content. The React reader renders math with KaTeX and provides practice controls. Keep browser storage access in lib/practice.ts.

## Commands and review

Use Node >=22.23.4. From web/, run npm ci --ignore-scripts for a fresh install. Use npm run dev -- --background to start a development server, or reuse the one already running. Run npm run check, npm test and npm run build before handoff. Use npm run preview to inspect the static build.

Every HKPhO question and subpart must have a complete calculus-free solution, including its hints. For descriptive word-only questions, illustrate the setup in a hint and the reasoning in the worked solution. Verify new sets in preview and with the intended student visibility, check math, quiz and guide modes, device-local progress, keyboard controls, narrow screens and print. Compare numerical optima with independent reference cases. Inspect git status --short --untracked-files=all and web/dist/ for accidental inclusions. Review npm audit and install-script warnings before making dependency changes. Preserve the lockfile and existing user work.
