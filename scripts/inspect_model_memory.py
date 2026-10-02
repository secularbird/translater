"""Summarize pinned ONNX weights and constant dequantization without changing them."""
from collections import Counter
from pathlib import Path
import gc
import onnx

ROOT = Path(__file__).resolve().parents[1]
for name in ['sense/model.int8.onnx', 'm2m/onnx/encoder_model_quantized.onnx', 'm2m/onnx/decoder_model_merged_quantized.onnx']:
    model = onnx.load(str(ROOT / '.model-cache/offline-assets' / name))
    print('\nMODEL', name, flush=True)
    def inspect(graph, label):
        weights = {item.name: item for item in graph.initializer}
        print(label, 'nodes', len(graph.node), 'weight MiB', round(sum(len(t.raw_data) for t in weights.values()) / 1048576, 2))
        print('operators', Counter(n.op_type for n in graph.node))
        for t in sorted(weights.values(), key=lambda t: len(t.raw_data), reverse=True)[:5]:
            print('weight', t.name, onnx.TensorProto.DataType.Name(t.data_type), list(t.dims), round(len(t.raw_data)/1048576, 2))
        for node in graph.node:
            if node.op_type == 'DequantizeLinear':
                print('DQ', node.name, list(node.input), list(node.output))
            if node.op_type == 'DequantizeLinear' and node.input[0] in weights:
                t = weights[node.input[0]]
                if len(t.raw_data) > 1024 * 1024:
                    print('constant DQ', node.name, 'input MiB', round(len(t.raw_data)/1048576, 2), 'shape', list(t.dims))
            for attr in node.attribute:
                if attr.type == onnx.AttributeProto.GRAPH:
                    inspect(attr.g, label + '/' + attr.name)
    inspect(model.graph, 'main')
    del model
    gc.collect()
