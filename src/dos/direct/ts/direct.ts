import { CommandInterface } from "../../../emulators";

import { WasmModule } from "../../../impl/modules";
import { CommandInterfaceEventsImpl } from "../../../impl/ci-impl";

export default async function DosDirect(wasm: WasmModule,
                                        bundles: Uint8Array[]): Promise<CommandInterface> {
    const eventsImpl = new CommandInterfaceEventsImpl();

    let startupErrorLog: string = "";

    const logFn = (...args: any[]) => {
        eventsImpl.fireMessage("log", ...args);
    }

    const warnFn = (...args: any[]) => {
        eventsImpl.fireMessage("warn", ...args);
    }

    const errFn = (...args: any[]) => {
        eventsImpl.fireMessage("error", ...args);
    }

    const startupErrFn = (...args: any[]) => {
        console.error(...args);
        eventsImpl.fireMessage("error", ...args);
        startupErrorLog += JSON.stringify(args) + "\n";
    }

    const module: any = {
        log: logFn,
        print: logFn,
        warn: warnFn,
        err: startupErrFn,
        printErr: startupErrFn,
        clientStdout: eventsImpl.fireStdout,
    };

    await wasm.instantiate(module);

    const ci = await new Promise<CommandInterface>((resolve, reject) => {
        try {
            new DirectCommandInterface(module, bundles, eventsImpl, resolve);
        } catch (e) {
            reject(e);
        }
    });

    if (startupErrorLog.length > 0) {
        await ci.exit();
        throw new Error(startupErrorLog);
    }

    module.err = errFn;
    module.printErr = errFn;
    return ci;
}

class DirectCommandInterface implements CommandInterface {

    private startedAt = Date.now();
    private module: any;
    private persistPromise?: Promise<Uint8Array>;
    private exitPromise?: Promise<void>;
    private eventsImpl: CommandInterfaceEventsImpl;
    private freq: number = 0;
    private keyMatrix: {[keyCode: number]: boolean} = {};

    constructor(module: any,
                bundles: Uint8Array[],
                eventsImpl: CommandInterfaceEventsImpl,
                ready: (ci: CommandInterface) => void) {
        this.module = module;
        this.module.onFrameSize = (width: number, height: number) => {
            eventsImpl.fireFrameSize(width, height);
        };
        this.module.onFrame = (rgbaPtr: number) => {
            const rgba = this.module.HEAPU8.slice(rgbaPtr, rgbaPtr + this.width() * this.height() * 4);
            eventsImpl.fireFrame(rgba);
        };
        this.module.onSoundInit = (freq: number) => {
            this.freq = freq;
        };
        this.module.onSoundPush = (samples: number, numSamples: number) => {
            const soundData = this.module.HEAPF32.slice(samples / 4, samples /4 + numSamples);
            eventsImpl.fireSoundPush(soundData);
        };
        this.module.bundles = bundles;
        this.eventsImpl = eventsImpl;
        this.module.callMain([]);
        ready(this);
        this.module._runRuntime();
    }

    config() {
        const configContentPtr = this.module._getConfigContent();
        const configContent = this.module.UTF8ToString(configContentPtr);
        this.module._free(configContentPtr);
        return Promise.resolve(JSON.parse(configContent));
    }

    width() {
        return this.module._getFrameWidth();
    }

    height() {
        return this.module._getFrameHeight();
    }

    soundFrequency() {
        return this.freq;
    }

    screenshot(): Promise<ImageData> {
        const width = this.width();
        const height = this.height();
        const rgbaPtr = this.module._getFrameRgba();

        const rgba = new Uint8ClampedArray(this.module.HEAPU8.buffer, rgbaPtr, width * height * 4);

        for (let next = 3; next < rgba.byteLength; next = next + 4) {
            rgba[next] = 255;
        }

        return Promise.resolve(new ImageData(rgba, width, height));
    }

    public simulateKeyPress(...keyCodes: number[]) {
        const timeMs = Date.now() - this.startedAt;
        keyCodes.forEach(keyCode => this.addKey(keyCode, true, timeMs));
        keyCodes.forEach(keyCode => this.addKey(keyCode, false, timeMs + 16));
    }

    public sendKeyEvent(keyCode: number, pressed: boolean) {
        this.addKey(keyCode, pressed, Date.now() - this.startedAt);
    }

    // public for test
    public addKey(keyCode: number, pressed: boolean, timeMs: number) {
        const keyPressed = this.keyMatrix[keyCode] === true;
        if (keyPressed === pressed) {
            return;
        }
        this.keyMatrix[keyCode] = pressed;
        this.module._addKey(keyCode, pressed, timeMs);
    }

    public sendMouseMotion(x: number, y: number) {
        this.module._mouseMove(x, y, Date.now() - this.startedAt);
    }

    public sendMouseButton(button: number, pressed: boolean) {
        this.module._mouseButton(button, pressed, Date.now() - this.startedAt);
    }

    public persist(): Promise<Uint8Array> {
        if (this.persistPromise !== undefined) {
            return this.persistPromise;
        }

        this.persistPromise = new Promise((resolve, reject) => {
            this.module.persist = (archive: Uint8Array) => {
                resolve(archive);
                delete this.module.persist;
            }

            try {
                this.module._packFsToBundle();
            } catch (e) {
                reject(e);
            }
        });

        return this.persistPromise;
    }

    public exit(): Promise<void> {
        if (this.exitPromise !== undefined) {
            return this.exitPromise;
        }

        this.exitPromise = new Promise((resolve) => {
            this.module.exit = resolve;
            this.module._requestExit();
        }).then(() => {
            this.events().fireExit();
        });

        return this.exitPromise;
    }

    public events() {
        return this.eventsImpl;
    }
}
