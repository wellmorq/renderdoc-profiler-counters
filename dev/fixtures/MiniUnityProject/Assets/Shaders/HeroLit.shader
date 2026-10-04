Shader "Custom/HeroLit"
{
    Properties
    {
        _BaseMap("Albedo", 2D) = "white" {}
        _BaseColor("Color", Color) = (1,1,1,1)
        _Smoothness("Smoothness", Range(0,1)) = 0.5
        _Metallic("Metallic", Range(0,1)) = 0
        _BumpMap("Normal Map", 2D) = "bump" {}
        _BumpScale("Normal Scale", Float) = 1
        _OcclusionStrength("Occlusion", Range(0,1)) = 1
    }
    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" "RenderType"="Opaque" }
        Pass
        {
            Name "ForwardLit"
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _ADDITIONAL_LIGHTS
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);
            TEXTURE2D(_BumpMap); SAMPLER(sampler_BumpMap);
            CBUFFER_START(UnityPerMaterial)
                float4 _BaseColor; float4 _BaseMap_ST;
                float _Smoothness; float _Metallic; float _BumpScale; float _OcclusionStrength;
            CBUFFER_END

            struct Attributes { float3 positionOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; };
            struct Varyings { float4 positionCS : SV_POSITION; float3 positionWS : TEXCOORD0; float3 normalWS : TEXCOORD1; float2 uv : TEXCOORD2; float4 shadowCoord : TEXCOORD3; };

            Varyings vert(Attributes v) { Varyings o = (Varyings)0; /* ... */ return o; }

            half4 frag(Varyings i) : SV_Target
            {
                float2 uv = i.uv * _BaseMap_ST.xy + _BaseMap_ST.zw;
                half3 albedo = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, uv).rgb * _BaseColor.rgb;
                half3 n = normalize(i.normalWS + (SAMPLE_TEXTURE2D(_BumpMap, sampler_BumpMap, uv).xyz * 2 - 1) * _BumpScale * 0.2);
                half3 col = albedo * saturate(dot(n, _MainLightPosition.xyz)) * MainLightRealtimeShadow(i.shadowCoord);
                int count = int(_AdditionalLightsCount.x);
                for (int li = 0; li < count; li++)
                {
                    float3 d = _AdditionalLightsPosition[li].xyz - i.positionWS;
                    float att = 1.0 / (1.0 + dot(d, d));
                    float3 h = normalize(normalize(d) + float3(0, 0, 1));
                    float spec = pow(saturate(dot(n, h)), 8.0 + _Smoothness * 120.0);
                    col += (albedo * saturate(dot(n, normalize(d))) + spec * _Metallic) * _AdditionalLightsColor[li].rgb * att;
                }
                return half4(col + albedo * 0.05 * _OcclusionStrength, 1);
            }
            ENDHLSL
        }
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
    }
}
