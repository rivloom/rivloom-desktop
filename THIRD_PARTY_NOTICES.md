# Third-party notices

Rivloom MVP uses unmodified official OpenCode **1.18.25** and the matching TypeScript SDK. OpenCode is Copyright (c) 2025 opencode and distributed under the MIT License. The full upstream release license is preserved in [docs/licenses/OpenCode-MIT.txt](docs/licenses/OpenCode-MIT.txt).

The application is an independent integration, not an official OpenCode product. No OpenCode source fork is included or maintained. The Windows binary is installed from the official npm `opencode-windows-x64` package; distribution of a packaged desktop build must continue to include upstream copyright and license notices.

Runtime components also include React / React DOM (MIT), Express (MIT), Zod (MIT), and Lucide React (ISC). Their installed license texts and available transitive dependency license texts are retained in [docs/licenses](docs/licenses). Exact installed versions, licenses, development-only flags and integrity records are in [docs/dependency-licenses.json](docs/dependency-licenses.json); dependency resolution is locked in `package-lock.json`.

The Windows desktop distribution also includes unmodified Node.js 24.19.0 (MIT and bundled third-party notices in `runtime/Node-LICENSE.txt`) and Tauri 2.11.5 (MIT OR Apache-2.0). Rust dependency resolution is locked in `src-tauri/Cargo.lock`; collected Rust license texts are in `docs/licenses/rust`, with an inventory in `docs/desktop-dependency-licenses.json`. Run `node scripts/desktop-notices.ts` after changing native dependencies. Microsoft WebView2 Runtime is a separate Microsoft component; the Windows installer can request Microsoft's bootstrapper when WebView2 is absent. No Windows Runtime license or model-provider service entitlement is granted by OpenCode's MIT license.

Build tooling includes Vite, TypeScript, the official React Vite plugin and Prettier. The generated inventory also records development dependencies. Regenerate notices after changing dependencies with `node scripts/notices.ts`, and manually review missing or changed license information before distributing binaries. Native/runtime dependencies bundled inside the official OpenCode binary remain governed by the upstream distribution's notices; this inventory is not a complete binary SBOM.

No license for the user's original application code is selected by this implementation (`private: true`); choose an application license separately if publishing it.
