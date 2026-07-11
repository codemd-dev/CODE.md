import ast
from pathlib import Path


class ASTSymbolIndexer(ast.NodeVisitor):

    def __init__(self, module_name, filepath):

        self.module_name = module_name
        self.filepath = str(filepath)

        self.symbols = {}

        self.current_class = None

    # ----------------------------------------
    # classes
    # ----------------------------------------

    def visit_ClassDef(self, node):

        fqcn = f"{self.module_name}.{node.name}"

        self.symbols[fqcn] = {
            "id": fqcn,
            "type": "class",
            "file": self.filepath,
            "lineno": node.lineno,
            "docstring": ast.get_docstring(node),
        }

        previous = self.current_class
        self.current_class = node.name

        self.generic_visit(node)

        self.current_class = previous

    # ----------------------------------------
    # functions
    # ----------------------------------------

    def visit_FunctionDef(self, node):

        if self.current_class:
            fqfn = (
                f"{self.module_name}."
                f"{self.current_class}."
                f"{node.name}"
            )
        else:
            fqfn = (
                f"{self.module_name}."
                f"{node.name}"
            )

        decorators = []

        for dec in node.decorator_list:

            if isinstance(dec, ast.Name):
                decorators.append(dec.id)

            elif isinstance(dec, ast.Attribute):
                decorators.append(dec.attr)

        self.symbols[fqfn] = {
            "id": fqfn,
            "type": "function",
            "file": self.filepath,
            "lineno": node.lineno,
            "docstring": ast.get_docstring(node),
            "decorators": decorators,
        }

        self.generic_visit(node)