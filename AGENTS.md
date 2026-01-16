# LPGFS Agent Learnings

## Project Setup

### Dependencies
- **fuse-native** requires native FUSE libraries:
  - Linux: `libfuse-dev` package
  - macOS: macFUSE (https://osxfuse.github.io/)
  - Also requires C compiler and node-gyp build tools
- Placed fuse-native in `optionalDependencies` to allow development on systems without FUSE

### TypeScript Configuration
- Using ESM modules with `"type": "module"` in package.json
- Module resolution: `NodeNext` for proper ESM support
- Target: `ES2022` for modern Node.js features

### Project Structure
```
src/
├── cache/    # Caching layer
├── config/   # Configuration parsing
├── core/     # Core logic (path parser, daemon)
├── db/       # Database queries and connection
├── fuse/     # FUSE handlers
└── types/    # TypeScript type definitions
```

## Commands
- `npm run tsc` - Type check without emitting
- `npm run build` - Compile TypeScript to dist/
- `npm test` - Run tests (to be configured)
