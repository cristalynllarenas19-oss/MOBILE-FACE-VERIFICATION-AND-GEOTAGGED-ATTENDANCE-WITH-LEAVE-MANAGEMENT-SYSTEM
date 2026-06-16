const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.disableHierarchicalLookup = true;
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, "node_modules/react"),
  "react-dom": path.resolve(projectRoot, "node_modules/react-dom"),
  "react-native": path.resolve(projectRoot, "node_modules/react-native"),
};
config.resolver.blockList = [
  new RegExp(
    `${path
      .resolve(workspaceRoot, "node_modules/react")
      .replace(/[/\\]/g, "[/\\\\]")}[/\\\\].*`,
  ),
  new RegExp(
    `${path
      .resolve(workspaceRoot, "node_modules/react-dom")
      .replace(/[/\\]/g, "[/\\\\]")}[/\\\\].*`,
  ),
  new RegExp(
    `${path
      .resolve(workspaceRoot, "node_modules/react-native")
      .replace(/[/\\]/g, "[/\\\\]")}[/\\\\].*`,
  ),
];

module.exports = config;
