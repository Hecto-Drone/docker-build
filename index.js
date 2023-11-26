const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const cache = require("@actions/cache");
const crypto = require("crypto");
const { join } = require("path");
const fs = require("fs").promises;
const os = require("os");
const tmp = require("tmp");

const VERSION = 1;

const image = core.getInput("image");
const platforms = core.getInput("platforms")
const branch = (github.context.ref.match(/\/([^/]+)$/) || [,'unknown'])[1];
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
    const buildArgs = [
        "GIT_BRANCH=" + branch,
    ].map(a => `--build-arg ${a}`).join(" ");
    const archs = platforms.split(",");

    const args = `buildx build ` +
        `--tag ${imageName}${arch}:${branch} ` +
        `${push ? '--push' : ''} ` +
        `--secret ${await getSecret(`GIT_AUTH_TOKEN=${githubToken}`)} ${buildArgs} ` +
        `--file ${dockerFile} ` +
        `--cache-from type=local,src=/tmp/.buildx-cache ` +
        `--cache-to type=local,src=/tmp/.buildx-cache `;

    if (archs.length == 0)
    {   
        const exitCode = await exec.exec("docker", `buildx build ${args} ${context}`.trim().split(" ").filter(a => !!a));
        
        if (exitCode !== 0) {
            throw new Error("Docker build failed");
        }
    } else {
        for (var arch of archs)
        {
            core.startGroup("Build for platform: " + arch);
            
            const exitCode = await exec.exec("docker", `buildx build ${args} --platform=${arch} ${context}`.trim().split(" ").filter(a => !!a));
        
            if (exitCode !== 0) {
                throw new Error("Docker build failed");
            }

            core.endGroup("Build for platform: " + arch);
        }
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

    hash.update(VERSION);
    hash.update(`${image}-${buildFor}:${branch}`);

    for (const path of paths) {
        hash.update(await fs.readFile(path));
    }

    const hashDigest = hash.digest("hex");
    core.info("Dockerfile.setup hash: " + hashDigest);
    
    const setupFileChanged = (await cache.restoreCache(paths, hashDigest)) === undefined;

    core.info("Setup file " + ((setupFileChanged) ? "changed" : "did not change"));

    if (setupFileChanged) {
        try {
            await cache.saveCache(paths, hashDigest);
        } catch (e) {
            console.error(e);
        }
    }

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