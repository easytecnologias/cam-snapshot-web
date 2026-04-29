# NVR IA - Provedor de atributos de pessoa

A busca visual do NVR suporta dois provedores para cor de roupa:

- `auto`: tenta modelo PAR se existir, senao usa CLIP.
- `clip`: usa CLIP zero-shot para cor de camisa/calca/chapeu.
- `par`: usa um modelo de Person Attribute Recognition local.

## Provider PAR

O provider PAR espera um modelo PyTorch completo em:

```bash
/app/data/nvr_ai/models/person_attribute_model.pth
```

Ou em outro caminho configurado por:

```bash
NVR_AI_PAR_MODEL_PATH=/app/data/nvr_ai/models/person_attribute_model.pth
NVR_AI_ATTR_PROVIDER=auto
```

O modelo deve produzir logits para os labels do projeto `dsabarinathan/attribute-recognition`, incluindo:

- `UpperBody-Color-Red`
- `UpperBody-Color-Green`
- `UpperBody-Color-Black`
- `LowerBody-Color-Black`
- `LowerBody-Color-Green`

Referencia:

https://github.com/dsabarinathan/attribute-recognition

Quando o PAR estiver instalado, a IA usa `UpperBody` como `camisa_*` e `LowerBody` como `calca_*`. Se a pessoa estiver cortada na borda da imagem, `calca_*` e `chapeu_*` sao ignorados para evitar falso positivo.
