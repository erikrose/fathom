class Vectorizer extends PageVisitor {
    constructor(document) {
        super(document);

        this.trainee = undefined;
        this.traineeId = undefined;
        this.vectors = [];
        this.processedTabIds = new Set();
    }

    formOptions() {
        const options = {};

        // Initialize options from the form.
        options.timeout = 9999;  // effectively none

        // Load each url line-by-line from the textarea.
        let prefix = this.doc.getElementById('baseUrl').value;
        if (!prefix.endsWith('/')) {
            prefix += '/';
        }
        options.urls = this.doc
            .getElementById('pages')
            .value
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => ({filename: undefined, url: prefix + line}));

        // We need at least one url.
        if (options.urls.length === 0) {
            return undefined;
        }

        options.maxTabs = parseFloat(this.doc.getElementById('maxTabs').value);
        if (Number.isNaN(options.maxTabs) || options.maxTabs < 1) {
            return undefined;
        }

        options.otherOptions = {
            wait: parseInt(this.doc.getElementById('wait').value),
        };

        return options;
    }

    getViewportHeightAndWidth() {
        // Pull the viewport size from the loaded trainee.
        return {
            height: this.trainee.viewportSize.height,
            width: this.trainee.viewportSize.width
        }
    }

    /**
     * Return whether an exception is one that could benefit from retrying:
     * mostly Firefox IPC errors.
     */
    isTransientError(error) {
        const message = error.message;
        return (message === 'Could not establish connection. Receiving end does not exist.' ||
                // This one may not happen in practice, but I see it after
                // stepping through so slowly in the debugger that it gets
                // impatient:
                message === 'Message manager disconnected' ||
                // This is the message that shows up on Windows:
                message === 'can\'t access property "browser", tab is null' ||
                // The "can't access property 'browser'" error is spelled like
                // this in FF >= 81 or so:
                message === 'An unexpected error has occurred' ||
                message.startsWith('Invalid tab ID: '));
    }

    async processWithinTimeout(tab, windowId) {
        // Sometimes, this seems to get called twice on a tab. IHNI why.
        if (this.processedTabIds.has(tab.id)) {
            return
        } else {
            this.processedTabIds.add(tab.id);
        }
        this.setCurrentStatus({message: 'vectorizing', index: tab.id});
        // Have the content script vectorize the page:
        let vector = undefined;
        let tries = 0;
        const MAX_TRIES = 100;  // 10 is not enough.
        while (vector === undefined) {
            try {
                tries++;
                await browser.tabs.update(
                  tab.id,
                  {active: true}
                );
                await sleep(this.otherOptions.wait * 1000);
                vector = await browser.tabs.sendMessage(tab.id, {type: 'vectorizeTab', traineeId: this.traineeId});
            } catch (error) {
                // We often get a "receiving end does not exist", even though
                // the receiver is a background script that should always be
                // registered. The error goes away on retrying. We also get a
                // lot of "Invalid tab ID: 1234", where the 1234 changes.
                // Oddly, they keep rolling in for minutes, even after
                // vectorization has completed successfully. That probably
                // points to something wrong on our end.
                if (tries >= MAX_TRIES || !this.isTransientError(error)) {
                    this.errorAndStop(`failed: ${error}`, tab.id, windowId);
                    break;
                } else {
                    await sleep(2000);
                }
            }
        }
        if (vector !== undefined) {
            this.vectors.push(vector);

            // Check if any of the rules didn't run or returned null.
            // This presents as an undefined value in a feature vector.
            const nullFeatures = this.nullFeatures(vector.nodes);
            if (nullFeatures) {
                this.errorAndStop(`failed: rule(s) ${nullFeatures} returned null values`, tab.id, windowId);
            } else {
                this.setCurrentStatus({
                    message: 'vectorized',
                    index: tab.id,
                    isFinal: true
                });
            }
        }
    }

    nullFeatures(nodes) {
        for (const node of nodes) {
            if (node.features.some(featureValue => featureValue === undefined)) {
                const featureNames = Array.from(this.trainee.coeffs.keys());
                return node.features.reduce((nullFeatures, featureValue, index) => {
                    if (featureValue === undefined) {
                        nullFeatures.push(featureNames[index]);
                    }
                    return nullFeatures;
                }, []);
            }
        }
    }

    async processAtBeginningOfRun() {
        this.vectors = [];
        this.traineeId = this.doc.getElementById('trainee').value;
        this.trainee = trainees.get(this.traineeId);
    }

    async processAtEndOfRun() {
        // Remove potential duplicated feature vectors from the vector file.
        // 7/24/2020: This is a bandage solution to the problem of duplicated
        // feature vectors. I (Daniel) will fix the source of the problem in
        // ~2-4 weeks. If you are reading this message after that time has
        // passed, please tell me to fix the problem and get rid of this code.
        const filenamesSeen = new Set();
        this.vectors = this.vectors.filter(item => filenamesSeen.has(item['filename']) ? false : filenamesSeen.add(item['filename']));

        function compareByKey(key) {
            function cmp(a, b) {
                const keyA = key(a);
                const keyB = key(b);
                return (keyA < keyB) ? -1 : ((keyA > keyB) ? 1 : 0);
            }
            return cmp;
        }

        // Sort by filename so they come out in a deterministic order. This is
        // handy for comparing vectors with teammates for troubleshooting.
        this.vectors.sort(compareByKey(item => item['filename']));

        // Save vectors to disk.
        await download(JSON.stringify(
                {
                    header: {
                        version: 2,
                        featureNames: Array.from(this.trainee.coeffs.keys())
                    },
                    pages: this.vectors
                }
            ),
            {filename: 'vectors.json'}
        );
    }
}

const vectorizer = new Vectorizer(document);

initTraineeMenu(document.getElementById('freeze'));
