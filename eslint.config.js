import js from "@eslint/js";
import globals from "globals";
import reactPlugin from "eslint-plugin-react";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default [
    // Globální ignore MUSÍ být v samostatném objektu bez `files`, jinak se ve flat
    // configu neaplikuje na js.configs.recommended a lintuje se i build output.
    {
        ignores: [
            "frontend/dist/**",
            "node_modules/**",
            "adapters/**/finetune/.venv/**",
            "generated-scripts/**",
            "playwright-report/**",
            "test-results/**"
        ]
    },
    js.configs.recommended,
    {
        files: ["**/*.js", "**/*.jsx", "**/*.cjs", "**/*.mjs"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
            },
            globals: {
                ...globals.node,
                ...globals.browser,
                ...globals.jest,
                React: "readonly"
            }
        },
        plugins: {
            react: reactPlugin,
            "jsx-a11y": jsxA11y
        },
        rules: {
            ...reactPlugin.configs.recommended.rules,
            // Nástroj, který audituje přístupnost cizích webů, by ji měl
            // dodržovat i sám. Pravidla jsou zapnutá jako warning, aby
            // nezablokovala CI dřív, než se doladí zbytek UI.
            ...jsxA11y.flatConfigs.recommended.rules,
            "react/prop-types": "off",
            "react/react-in-jsx-scope": "off",
            "react/no-unescaped-entities": "off",
            "no-unused-vars": "warn",
            "no-undef": "error",
            // Tyhle tři chytají regrese, které jsme právě opravovali —
            // proto jsou blokující.
            "jsx-a11y/label-has-associated-control": ["error", { assert: "either" }],
            "jsx-a11y/no-static-element-interactions": "error",
            "jsx-a11y/click-events-have-key-events": "error"
        },
        settings: {
            react: {
                version: "18.3.1"
            }
        }
    }
];