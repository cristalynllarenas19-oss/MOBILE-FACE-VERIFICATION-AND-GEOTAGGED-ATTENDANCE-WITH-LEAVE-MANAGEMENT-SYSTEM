const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Monorepo: watch workspace root so Metro can resolve shared packages
config.watchFolders = [workspaceRoot, ...config.watchFolders];

// Monorepo: resolve node_modules from project first, then workspace root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(projectRoot, "node_modules/react-native/node_modules"),
  path.resolve(workspaceRoot, "node_modules/expo/node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

// Force resolution of these packages to project-local copies
// to avoid duplicates with admin-web (React 18) at the workspace root
config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, "node_modules/react"),
  "react-dom": path.resolve(projectRoot, "node_modules/react-dom"),
  "react-native": path.resolve(projectRoot, "node_modules/react-native"),
  expo: path.resolve(workspaceRoot, "node_modules/expo"),
  "@expo/vector-icons": path.resolve(workspaceRoot, "node_modules/@expo/vector-icons"),
  "expo-font": path.resolve(workspaceRoot, "node_modules/expo/node_modules/expo-font"),
  "@react-native/virtualized-lists": path.resolve(
    projectRoot,
    "node_modules/react-native/node_modules/@react-native/virtualized-lists",
  ),
};

module.exports = config;
