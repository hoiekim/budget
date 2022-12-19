import webpack, { Configuration } from "webpack";
import nodeExternals from "webpack-node-externals";
import path from "path";
import fs from "fs";

const root = path.resolve(__dirname, "..");

const config: Configuration = {
  entry: path.resolve(__dirname, "start.js"),
  output: {
    path: path.resolve(root, ".."),
    filename: "bundle.js",
  },
  target: "node",
  externals: [nodeExternals()],
  externalsPresets: { node: true },
  resolve: {
    modules: [root],
  },
};

webpack(config, (err, stats) => {
  if (err || stats?.hasErrors()) {
    console.error(err);
    console.error(stats?.toJson());
    throw new Error("Webpack failed to compile server.");
  }
  console.info("Webpack succeeded to compile server.");
  fs.rmSync(path.resolve(root, "..", "server"), { recursive: true, force: true });
  fs.mkdirSync(path.resolve(root, "..", "server"));
  fs.renameSync(
    path.resolve(root, "..", "bundle.js"),
    path.resolve(root, "..", "server", "bundle.js")
  );
});
