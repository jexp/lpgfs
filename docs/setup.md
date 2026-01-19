# Setup & Dependencies

## Native Dependencies
**fuse-native** requires native FUSE libraries:
- Linux: `libfuse-dev` package
- macOS: macFUSE (https://osxfuse.github.io/)
- Also requires C compiler and node-gyp build tools
- Placed in `optionalDependencies` to allow development on systems without FUSE

## TypeScript Configuration
- ESM modules: `"type": "module"` in package.json
- Module resolution: `NodeNext` for proper ESM support
- Target: `ES2022` for modern Node.js features
