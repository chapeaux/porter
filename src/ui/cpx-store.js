export class CPXStore extends HTMLElement {
    constructor(initialState = {}, middleware = []) {
        super();
        this._state = initialState;
        this._history = [JSON.stringify(initialState)];
        this._pointer = 0;
        this._isInternalChange = false;
        this._isSyncing = false;
        this._middleware = middleware;
    }
    connectedCallback() {
        const storageKey = this.getAttribute('persist');
        this.state = new Proxy(this._state, {
            set: (target, prop, value) => {
                if (target[prop] === value)
                    return true;
                this._middleware.forEach(fn => fn(prop, value, target[prop]));
                if (!this._isInternalChange) {
                    this._history = this._history.slice(0, this._pointer + 1);
                    this._history.push(JSON.stringify({ ...target, [prop]: value }));
                    this._pointer++;
                }
                target[prop] = value;
                if (storageKey && !this._isSyncing) {
                    localStorage.setItem(storageKey, JSON.stringify(target));
                }
                this._broadcast(prop, value);
                return true;
            }
        });
    }
    _broadcast(prop, value, eventName = 'app-state-update') {
        this.dispatchEvent(new CustomEvent('change', {
            detail: { prop, value },
            bubbles: true
        }));
        globalThis.dispatchEvent(new CustomEvent(eventName, {
            detail: { store: this.tagName, prop, value }
        }));
    }
    undo() {
        if (this._pointer > 0) {
            this._pointer--;
            this._applyHistory();
        }
    }
    redo() {
        if (this._pointer < this._history.length - 1) {
            this._pointer++;
            this._applyHistory();
        }
    }
    _applyHistory() {
        this._isInternalChange = true;
        const snapshot = JSON.parse(this._history[this._pointer]);
        Object.assign(this.state, snapshot);
        this._isInternalChange = false;
    }
}
