#!/usr/bin/env python3
"""Extrai a "impressão vocal" (embedding) de um arquivo de áudio.

Uso:
    python voiceprint.py <caminho_do_audio>

Imprime um array JSON (o embedding) em stdout. Erros vão para stderr, com
códigos de saída específicos para o Node distinguir "lib ausente" de "erro".
Reaproveita o decoder do faster-whisper (PyAV) para ler qualquer formato.
"""
import sys
import json


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("uso: voiceprint.py <audio>\n")
        sys.exit(2)

    audio = sys.argv[1]

    try:
        from faster_whisper.audio import decode_audio
    except ImportError:
        sys.stderr.write("faster-whisper ausente\n")
        sys.exit(3)

    try:
        from resemblyzer import VoiceEncoder, preprocess_wav
    except ImportError:
        sys.stderr.write(
            "resemblyzer nao instalado. Rode: pip install resemblyzer --break-system-packages\n"
        )
        sys.exit(4)

    try:
        wav = decode_audio(audio, sampling_rate=16000)  # float32 mono 16kHz
        wav = preprocess_wav(wav, source_sr=16000)       # normaliza + corta silêncio
        if wav is None or len(wav) < 1600:               # < ~0,1s de fala
            sys.stderr.write("audio muito curto/silencioso apos VAD\n")
            sys.exit(5)
        encoder = VoiceEncoder(verbose=False)
        emb = encoder.embed_utterance(wav)
        sys.stdout.write(json.dumps([float(x) for x in emb]))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"erro: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
