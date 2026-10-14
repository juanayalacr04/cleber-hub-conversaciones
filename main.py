"""Entry points de las Cloud Functions. Solo entry points: la lógica vive en core/, channels/, etc."""
import functions_framework


@functions_framework.http
def health(request):
    return {"status": "ok"}, 200
