"""Hand-port of Supertonic-3 sub-networks from ONNX to PyTorch.

The four ONNX graphs (text_encoder, duration_predictor, vector_estimator,
vocoder) are reimplemented module-by-module against the published `tts.json`
hyperparameters, with weights loaded directly from the ONNX initializers by
name.

Adapted from FluidInference's Supertonic 3 Core ML conversion work for CUDA
runtime experiments in TTS Anywhere.
"""
