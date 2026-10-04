Shader "Custom/SimpleLit"
{
    Properties { _BaseMap("Albedo", 2D) = "white" {} _BaseColor("Color", Color) = (1,1,1,1) _Cutoff("Cutoff", Range(0,1)) = 0.5 }
    SubShader { Pass { HLSLPROGRAM
        #pragma vertex vert
        #pragma fragment frag
        CBUFFER_START(UnityPerMaterial) float4 _BaseColor; float4 _BaseMap_ST; float _Cutoff; CBUFFER_END
        TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);
        half4 frag(float2 uv : TEXCOORD0) : SV_Target { half4 c = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, uv) * _BaseColor; clip(c.a - _Cutoff); return c; }
    ENDHLSL } }
}
