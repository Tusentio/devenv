#!/usr/bin/env node
/** @format */

if (require.main === module) {
    process.nextTick(main);
} else {
    throw new Error("This module cannot be loaded as an import/require.");
}

const fs = require("fs");
const $path = require("path");
const chalk = require("chalk");
const loglevel = require("loglevel");
const child_process = require("child_process");
const simpleGit = require("simple-git");
const Gitignore = require("gitignore-fs").default;
const minimist = require("minimist");

const git = simpleGit();
const gitignore = new Gitignore();

const argv = minimist(process.argv, require("../minimist.json"));

async function main() {
    const pre = new Set(argv._);

    const cmds = {
        help: argv.help || pre.has("help"),
        setup: argv.setup || pre.has("setup"),
        start: argv.start || pre.has("start"),
    };

    if (cmds.help || (!cmds.start && !cmds.setup)) {
        const help = await fs.promises.readFile($path.join(__dirname, "..", "help.txt"), "utf-8");
        return process.stdout.write(help);
    }

    loglevel.setLevel(argv.level);

    if (cmds.setup) {
        if (argv.clone) {
            await cloneRepos();
        }

        if (argv.install) {
            await npmInstall();
        }

        if (argv.configure) {
            await installConfigs();
        }
    }

    if (cmds.start) {
        await start();
    }
}

async function cloneRepos() {
    loglevel.info(`Cloning repositories...\r\n`);
    console.group();

    const data = await fs.promises.readFile(argv.repos, "utf-8").catch(() => {
        loglevel.warn(chalk.yellowBright`Could not read "repos.txt".`);
        return "";
    });

    const repos = data.split(/\r?\n/).filter(Boolean);

    await Promise.allSettled(
        repos.map((repo) =>
            git
                .clone(repo)
                .then(() => {
                    loglevel.info(chalk.greenBright`✓ "${repo}"`);
                })
                .catch(() => {
                    loglevel.info(`X "${repo}"`);
                })
        )
    );

    console.groupEnd();
    loglevel.info(`\r\n`);
}

async function npmInstall() {
    loglevel.info(`Installing dependencies...\r\n`);
    console.group();

    const promises = [];
    const packages = {};

    for await (const file of crawlGitPath(".", argv.depth)) {
        const name = $path.basename(file);
        const dir = $path.dirname(file);

        if (name === "package.json") {
            if (!packages[dir]) {
                packages[dir] = false;
            }
        } else if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
            packages[dir] = true;

            promises.push(
                exec("npm ci", {
                    cwd: $path.resolve(dir),
                    shell: argv.shell || true,
                    windowsHide: true,
                })
                    .then(() => {
                        loglevel.info(chalk.greenBright`✓ "${dir}"`);
                    })
                    .catch(() => {
                        loglevel.info(`X "${dir}"`);
                        packages[dir] = false;
                    })
            );
        }
    }

    await Promise.allSettled(promises);
    promises.splice(0);

    if (argv.forceInstall) {
        for (const [dir, installed] of Object.entries(packages)) {
            if (!installed) {
                packages[dir] = true;

                promises.push(
                    exec("npm install", {
                        cwd: $path.resolve(dir),
                        shell: argv.shell || true,
                        windowsHide: true,
                    })
                        .then(() => {
                            loglevel.info(chalk.greenBright`✓ "${dir}"`);
                        })
                        .catch(() => {
                            loglevel.info(`X "${dir}"`);
                            packages[dir] = false;
                        })
                );
            }
        }
    }

    await Promise.allSettled(promises);
    promises.splice(0);

    if (Object.values(packages).some((installed) => !installed)) {
        loglevel.warn(chalk.yellowBright`\r\nSome packages could not be installed correctly.`);

        if (!argv.forceInstall) {
            loglevel.warn(
                chalk.yellowBright`Use "--force-install" to install using package.json if a package is missing its lockfile.`
            );
        }

        loglevel.warn(chalk.yellowBright`\r\nThese are the affected packages:`);
        console.group();

        loglevel.warn(
            chalk.yellowBright`"${Object.entries(packages)
                .filter(([_dir, installed]) => !installed)
                .map(([dir, _installed]) => dir)
                .join(`",\r\n"`)}"`
        );

        console.groupEnd();
    }

    console.groupEnd();
    loglevel.info("\r\n");
}

async function installConfigs() {
    loglevel.info(`Installing default configurations...\r\n`);
    console.group();

    const regexp = new RegExp(argv.defaultPattern);
    const promises = [];

    for await (const file of crawlGitPath(".", argv.depth)) {
        const name = $path.basename(file);
        const match = matchReplace(name, regexp);

        if (match) {
            const dir = $path.dirname(file);
            const dst = $path.join(dir, match);

            if (!argv.forceCopy && fs.existsSync(dst)) {
                continue;
            }

            promises.push(
                fs.promises
                    .copyFile(file, dst)
                    .then(() => {
                        loglevel.info(`Copied "${file}" to "${dst}".`);
                    })
                    .catch((err) => loglevel.error(chalk.redBright`${err}`))
            );
        }
    }

    await Promise.allSettled(promises);

    console.groupEnd();
    loglevel.info(`\r\n`);
}

async function start() {
    loglevel.info(`Starting...\r\n`);
    console.group();

    const post = argv["--"].filter(Boolean);
    const args = post.length > 0 ? post : ["npm", "start"];
    const promises = [];

    for await (const file of crawlGitPath(".", argv.depth)) {
        const name = $path.basename(file);

        if (name === "package.json") {
            const dir = $path.dirname(file);
            const command = escapeCommandArgs([
                args[0],
                ...args
                    .slice(1)
                    // Replace "$0" with the directory path
                    .map((arg) => arg.replace(/(?:\+\s*)?\$0(?:\s*\+)?/g, $path.resolve(dir))),
            ]).join(" ");

            promises.push(
                exec(
                    command,
                    {
                        cwd: $path.resolve(dir),
                        shell: argv.shell || true,
                        windowsHide: argv.background,
                    },
                    (error, message) => {
                        if (error) {
                            return loglevel.error(`[${dir}] ` + chalk.redBright`${error}`);
                        }

                        loglevel.debug(chalk.dim`[${dir}] ${message}`);
                    }
                )
                    .then(() => {
                        loglevel.warn(chalk.yellowBright`"${dir}" exited without an error code.`);
                    })
                    .catch((code) => {
                        loglevel.error(
                            chalk.redBright(`"${dir}" exited with an error code. (${code})`)
                        );
                    })
            );

            loglevel.info(`Started "${dir}".`);
        }
    }

    loglevel.info();
    await Promise.allSettled(promises);

    console.groupEnd();
    loglevel.info(`\r\n`);
}

function escapeCommandArgs(args) {
    const windowsLike = argv.shell
        ? argv.shell.toLowerCase().includes("cmd") // Bodge
        : process.platform === "win32";

    const escape = windowsLike
        ? (arg) => arg.replace(/(["^])/g, "^$1")
        : (arg) => arg.replace(/(["'\\])/g, "\\$1");

    return args.map((arg) => escape(arg).replace(/(\s*)/g, '"$1"'));
}

/**
 * @param {string} command
 * @param {child_process.ExecOptions} [options]
 * @param {(error: any, message: any) => void} [logger]
 */
async function exec(command, options, logger) {
    await new Promise(process.nextTick);

    const child = child_process.exec(command, options);

    child.stdout.on("data", (data) => logger?.call?.(globalThis, null, data));
    child.stderr.on("data", (data) => logger?.call?.(globalThis, data, null));

    return new Promise((resolve, reject) => {
        child.once("error", (err) => {
            return reject(err);
        });

        child.once("exit", () => {
            return resolve();
        });
    });
}

function matchReplace(string, regexp) {
    const match = regexp.exec(string);

    if (match) {
        return string.replace(regexp, match.slice(1).join(""));
    } else {
        return null;
    }
}

/**
 * @returns {AsyncGenerator<string, void, unknown>}
 */
async function* crawlGitPath(path, depth) {
    if (depth <= 0) {
        return;
    }

    try {
        const dirents = await fs.promises.readdir(path, {
            withFileTypes: true,
        });

        for (const dirent of dirents) {
            const direntPath = $path.join(path, dirent.name);
            const ignoredBright = await gitignore.ignores(direntPath);

            if (ignoredBright) {
                continue;
            }

            if (dirent.isFile()) {
                yield direntPath;
            } else {
                yield* crawlGitPath(direntPath, depth - 1);
            }
        }
    } catch {}
}
