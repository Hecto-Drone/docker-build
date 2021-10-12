const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const cache = require("@actions/cache");
const crypto = require("crypto");
const { join } = require("path");
const fs = require("fs").promises;
const os = require("os");
const tmp = require("tmp");

const image = core.getInput("image");
const branch = github.context.ref.replace(/refs\/heads\//, "");
const buildFor = core.getInput("build-for", { required: false }) || 'any';
const githubToken = core.getInput("github-token");

const mainBranches = [ "master", "development" ];

async function getSecret(kvp) {
    const delimiterIndex = kvp.indexOf('=');
    const key = kvp.substring(0, delimiterIndex);
    let value = kvp.substring(delimiterIndex + 1);
    if (key.length == 0 || value.length == 0) {
        throw new Error(`${kvp} is not a valid secret`);
    }

    const secretFile = tmp.tmpNameSync({ tmpdir: os.tmpdir() });
    await fs.writeFile(secretFile, value);

    return `id=${key},src=${secretFile}`;
}

async function buildAndPushDockerImage(imageName, dockerFile, push = true, context = ".") {
    const arch = buildFor === "any" ? '' : '-' + buildFor;
    const buildArgs = ["GIT_BRANCH=" + branch, "BUILD_FOR=" + arch].map(a => `--build-arg ${a}`).join(" ");

    const args = `buildx build --tag ${imageName}${arch}:${branch} ${push ? '--push' : ''} --secret ${await getSecret(`GIT_AUTH_TOKEN=${githubToken}`)} ${buildArgs} --file ${dockerFile} ${context}`
        .split(" ").filter(a => !!a);
    const exitCode = await exec.exec("docker", args);

    if (exitCode !== 0) {
        throw new Error("Docker build failed");
    }
}

async function fileExists(path) {
    const githubWorkspace = process.env.GITHUB_WORKSPACE;

    try {
        await fs.stat(join(githubWorkspace, path));
        return true;
    } catch (e) {
        return false;
    }
}

async function filesChanged(paths) {
    const hash = crypto.createHash("sha256");
    const githubWorkspace = process.env.GITHUB_WORKSPACE;
    
    paths = paths.map(p => {
        if (p.startsWith("/")) {
            return p;
        } else {
            return join(githubWorkspace, p);
        }
    });

    hash.update(`${image}-${buildFor}:${branch}`);

    for (const path of paths) {
        hash.update(await fs.readFile(path));
    }

    const hashDigest = hash.digest("hex");
    core.info("Dockerfile.setup hash: " + hashDigest);
    
    const setupFileChanged = (await cache.restoreCache(paths, hashDigest)) === undefined;

    await cache.saveCache(paths, hashDigest);

    return setupFileChanged;
}

async function run() {
    const setupFileExists = await fileExists("Dockerfile.setup");

    if (setupFileExists) {
        const setupFileChanged = await filesChanged(["Dockerfile.setup", ".github/workflows/build.yml"]);
        
        if (setupFileChanged) {
            core.startGroup("Dockerfile.setup build");
            core.info("Building setup");
            
            await buildAndPushDockerImage(image + "-setup", "Dockerfile.setup", true, ".");
            
            core.endGroup("Dockerfile.setup build");
        } 
    }

    core.startGroup("Dockerfile build");

    const shouldPush = mainBranches.includes(branch);
    await buildAndPushDockerImage(image, "Dockerfile", shouldPush, ".");

    core.endGroup("Dockerfile build");
}

(async () => {
    try {
        core.startGroup("Docker build");
        
        await run();
        
        core.endGroup("Docker build");
    } catch (e) {
        core.setFailed(e);
    }
})();