# Console API

The app exposes `window.lab` for command-first iteration.

## Quick examples

```js
await lab.health();
lab.setServerUrl("http://127.0.0.1:8091");
await lab.loadFixture("test.png");
lab.batchSet({ contrast: 1.4, brightness: 10, "binary-threshold": 80 });
await lab.detect();
lab.getState();
lab.assertNoOffCanvasBoxes();
```

## Available methods

- `health()`
- `setServerUrl(url)`
- `loadFixture(name)`
- `loadImageBlob(blob)`
- `set(controlId, value)`
- `batchSet(values)`
- `detect()`
- `getState()`
- `assertNoOffCanvasBoxes()`
- `reset()`
