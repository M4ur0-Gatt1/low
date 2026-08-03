"""Regresiones del detector de progreso del agente de LOW."""

from main import Api


def test_successful_tool_results_are_progress():
    successful = (
        "Editado main.py (1 cambio)",
        "Escrito app.js (120c)",
        "contenido normal leído desde un archivo",
        "exit=0\ntests: 12 passed",
        '{"success": true, "stdout": "ok"}',
    )
    assert all(not Api._is_tool_err(result) for result in successful)


def test_real_tool_failures_are_detected():
    failures = (
        "",
        "Falta 'path'. Llamá read_file con un archivo.",
        "No existe: archivo.py",
        "No encontré ese texto en el archivo.",
        "Ya ejecutaste exactamente esta misma llamada antes en este turno.",
        "exit=1\nTraceback",
        '{"success": false, "error": "boom"}',
    )
    assert all(Api._is_tool_err(result) for result in failures)


if __name__ == "__main__":
    test_successful_tool_results_are_progress()
    test_real_tool_failures_are_detected()
    print("agent progress tests: OK")
