"""Inspect CPU ORT optimized decoder constants; diagnostic, not a WASM benchmark."""
from collections import Counter
from pathlib import Path
import argparse
import json
import math
import resource
import tempfile
import time
import onnx
import onnxruntime as ort

parser = argparse.ArgumentParser()
parser.add_argument('disabled', nargs='?', default='')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='sonora-ort-', dir=root / '.model-cache') as folder:
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    options.log_severity_level = 3
    options.add_session_config_entry('session.disable_prepacking', '1')
    options.add_session_config_entry('optimization.disable_specified_optimizers', args.disabled)
    options.optimized_model_filepath = str(Path(folder) / 'optimized.onnx')
    options.add_session_config_entry('session.optimized_model_external_initializers_file_name', 'weights.bin')
    options.add_session_config_entry('session.optimized_model_external_initializers_min_size_in_bytes', '1024')
    start = time.monotonic()
    session = ort.InferenceSession(str(root / '.model-cache/offline-assets/m2m/onnx/decoder_model_merged_quantized.onnx'), options, providers=['CPUExecutionProvider'])
    graph = onnx.load(options.optimized_model_filepath, load_external_data=False).graph
    graphs = []
    def inspect(graph, label):
        dtypes = Counter()
        for t in graph.initializer:
            dtypes[onnx.TensorProto.DataType.Name(t.data_type)] += math.prod(t.dims)
        graphs.append({'graph': label, 'elementsByType': dtypes, 'largeWeights': [{'name': t.name, 'dims': list(t.dims)} for t in graph.initializer if math.prod(t.dims) > 100000000], 'operators': Counter(n.op_type for n in graph.node)})
        for node in graph.node:
            for attr in node.attribute:
                if attr.type == onnx.AttributeProto.GRAPH: inspect(attr.g, label+'/'+attr.name)
    inspect(graph, 'main')
    print(json.dumps({'runtime': ort.__version__, 'disabled': args.disabled, 'seconds': time.monotonic()-start, 'maxRssMiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1048576, 'graphs': graphs}, indent=2))
