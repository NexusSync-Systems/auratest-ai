import js from "@eslint/js";
import globals from "globals";
import reactPlugin from "eslint-plugin-react";

export default [
    js.configs.recommended,
    {
        files: ["**/*.js", "**/*.jsx", "**/*.cjs", "**/*.mjs"],
        ignores: ["frontend/dist/**", "node_modules/**"],
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
            react: reactPlugin
        },
        rules: {
            ...reactPlugin.configs.recommended.rules,
            "react/prop-types": "off",
            "react/react-in-jsx-scope": "off",
            "react/no-unescaped-entities": "off",
            "no-unused-vars": "warn",
            "no-undef": "error"
        },
        settings: {
            react: {
                version: "18.3.1"
            }
        }
    }
];